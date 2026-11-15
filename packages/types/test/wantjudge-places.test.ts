import type {
  JobResult,
  JobSpec,
  NoJob,
  Occurrence,
  Outcome,
  RunContext,
  Task,
  User,
} from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  type Listing,
  type ListingDetail,
  type Source,
  type SourceId,
  SourceMiss,
  SourceUnavailableError,
  type WantConfig,
  wantjudgeType,
} from "../src/index.js"

/**
 * A judged watch of several places (Rod, 2026-11-15: "start it right after 59"): one read over
 * every place, one model look at all they found, one DM, each listing by its own place.
 */

const NOW = new Date("2026-11-15T23:00:00Z")
const SHOP = "https://shop.example/s"
const SCHEDULED = NOW.toISOString()
const FOLLOW_UP = "followup:o1"

const copy = (id: string, price: number, url = `https://shop.example/p/${id}`): Listing => ({
  id: url,
  title: `Curse of the Rougarou -- ${id}`,
  url,
  price,
  currency: "USD",
})

const bggCopy = (n: number, price: number): Listing => ({
  id: `bgg:${n}`,
  title: `Curse of the Rougarou (BGG ${n})`,
  url: `https://boardgamegeek.com/geekmarket/product/${n}`,
  price,
  currency: "USD",
})

const ebayItem = (n: number, price: number): Listing => ({
  id: `ebay:${100000 + n}`,
  title: `Curse of the Rougarou eBay ${n}`,
  url: `https://www.ebay.com/itm/${100000 + n}`,
  ref: `v1|${100000 + n}|0`,
  price,
  currency: "USD",
  seller: "seller_a, 99.5% positive",
})

function stub(id: SourceId, listings: () => Listing[]): Source & { reads: string[] } {
  const reads: string[] = []
  return {
    id,
    reads,
    search: async (target: string) => {
      reads.push(target)
      return listings()
    },
  }
}

/** eBay's API: its search finds `found`; a full read comes from `live` (gone when absent) unless `down`. */
function ebay(found: Listing[], live = new Map(found.map((l) => [l.id, l]))) {
  const down = { on: false }
  const s: Source = {
    id: "ebay",
    search: async () => found,
    reread: async (l): Promise<ListingDetail | null> => {
      if (down.on) throw new SourceMiss("eBay is busy (HTTP 503)")
      const now = [...live.values()].find((x) => x.ref === l.ref)
      return now ? { text: `Item specifics for ${now.title}.`, listing: now } : null
    },
  }
  return { s, down, live }
}

function ctx(
  config: Partial<WantConfig> & Record<string, unknown>,
  state: unknown,
  dedupeKey = SCHEDULED,
  now = NOW,
): RunContext<WantConfig> {
  return {
    task: { id: "t1", title: "Rougarou" } as Task,
    occurrence: { id: "o1", taskId: "t1", dedupeKey } as Occurrence,
    owner: { id: "u1" } as User,
    recipients: [],
    config: { source: "page", target: SHOP, ...config } as WantConfig,
    // As stored between runs.
    state: state === null ? null : JSON.parse(JSON.stringify(state)),
    now,
    ports: {},
    history: { events: [], replies: [], series: [] },
  }
}

const success = (structuredOutput: unknown): JobResult =>
  ({ kind: "success", result: "", structuredOutput }) as JobResult
const outcomeOf = (out: JobSpec | NoJob | undefined) => (out as { outcome: Outcome }).outcome
const verdicts = (...fits: [number, string][]) => ({
  verdicts: fits.map(([n, fit]) => ({ n, fit, why: `listing ${n}`, seller: "not shown" })),
})

const BGG = { source: "bgg", target: "300580" } as const
const EBAY = { source: "ebay", target: "curse rougarou" } as const

describe("a judged watch of several places", () => {
  it("reads every place, asks the model once about all, and DMs each by its own place", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const bgg = stub("bgg", () => [bggCopy(9, 25)])
    const type = wantjudgeType({ page, bgg })
    const config = { also: [BGG] }
    const read = outcomeOf(await type.prepare?.(ctx(config, null)))
    expect(page.reads).toEqual([SHOP])
    expect(bgg.reads).toEqual(["300580"])
    expect(read.followUp).toEqual({})
    expect(read.notify).toBeUndefined()
    const state = read.state as { pending: { id: string; place?: string }[]; places?: unknown }
    expect(state.pending.map((l) => [l.id, l.place])).toEqual([
      ["https://shop.example/p/a", `page:${SHOP}`],
      ["bgg:9", "bgg:300580"],
    ])

    const job = (await type.prepare?.(ctx(config, state, FOLLOW_UP))) as JobSpec
    expect(job.prompt).toContain("1. Curse of the Rougarou -- a")
    expect(job.prompt).toContain("2. Curse of the Rougarou (BGG 9)")
    expect(job.prompt).toContain("a shop page they gave and BoardGameGeek's marketplace")
    // Each open place's own host, for its own listings only.
    expect(job.allowedTools?.sort()).toEqual([
      "WebFetch(domain:boardgamegeek.com)",
      "WebFetch(domain:shop.example)",
    ])

    const out = await type.finish?.(
      ctx(config, state, FOLLOW_UP),
      success(verdicts([1, "match"], [2, "no"])),
    )
    const text = out?.notify?.text ?? ""
    expect(text).toContain("Rougarou: a new listing worth a look (1 more did not look like it).")
    expect(text).toContain("<https://shop.example/p/a>")
    expect(text).not.toContain("BGG 9")
    expect(out?.findings?.map((f) => f.tags)).toEqual([
      ["wantlist", "page", "match"],
      ["wantlist", "bgg", "no"],
    ])
    const after = out?.state as { reported: string[]; pending: unknown[]; told: number }
    expect(after.pending).toEqual([])
    expect(after.told).toBe(1)
    expect(after.reported).toHaveLength(2)
    // Nothing is read again for what was told.
    const again = outcomeOf(await type.prepare?.(ctx(config, after)))
    expect(again.followUp).toBeUndefined()
  })

  it("holds eBay's listings as item numbers, reads them back for the model and the DM, and keeps none", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const e = ebay([ebayItem(1, 20)])
    const type = wantjudgeType({ page, ebay: e.s })
    const config = { also: [EBAY] }
    const read = outcomeOf(await type.prepare?.(ctx(config, null)))
    const state = read.state as {
      pending: unknown[]
      held: { id: string; ref: string; place?: string }[]
    }
    expect(state.pending).toHaveLength(1)
    expect(state.held).toEqual([
      { id: "ebay:100001", ref: "v1|100001|0", place: "ebay:curse rougarou" },
    ])
    expect(JSON.stringify(state)).not.toContain("seller_a")

    const job = (await type.prepare?.(ctx(config, state, FOLLOW_UP))) as JobSpec
    expect(job.prompt).toContain("2. Curse of the Rougarou eBay 1")
    expect(job.prompt).toContain("Item specifics for Curse of the Rougarou eBay 1.")
    expect(job.allowedTools).toEqual(["WebFetch(domain:shop.example)"])
    expect(job.disallowedTools).not.toContain("WebFetch")

    const out = await type.finish?.(
      ctx(config, state, FOLLOW_UP),
      success(verdicts([1, "match"], [2, "maybe"])),
    )
    const text = out?.notify?.text ?? ""
    expect(text).toContain("2 new listings worth a look")
    expect(text).toContain("<https://www.ebay.com/itm/100001>")
    // Each line by its own place: eBay's carries eBay's attribution, the page's none.
    expect(text).toMatch(/itm\/100001> \(.*eBay.*\)/)
    expect(text).toMatch(/p\/a>\n/)
    // The eBay listing is neither a finding nor a price.
    expect(out?.findings?.map((f) => f.source)).toEqual(["https://shop.example/p/a"])
    const after = out?.state as { prices?: { p: number }[]; reported: string[] }
    expect(after.prices?.map((x) => x.p)).toEqual([30])
    expect(after.reported).toHaveLength(2)
  })

  it("tells the page's listings when eBay cannot be read back, letting eBay's go to be found again", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const e = ebay([ebayItem(1, 20)])
    const type = wantjudgeType({ page, ebay: e.s })
    const config = { also: [EBAY] }
    const state = outcomeOf(await type.prepare?.(ctx(config, null))).state
    e.down.on = true
    const job = (await type.prepare?.(ctx(config, state, FOLLOW_UP))) as JobSpec
    expect(job.prompt).toContain("1. Curse of the Rougarou -- a")
    expect(job.prompt).not.toContain("eBay 1")
    const out = await type.finish?.(ctx(config, state, FOLLOW_UP), success(verdicts([1, "match"])))
    expect(out?.notify?.text).toContain("<https://shop.example/p/a>")
    const after = out?.state as { reported: string[] }
    expect(after.reported).toHaveLength(1)
  })

  it("warns at once about a place it cannot read, and still judges the others", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const bgg: Source = {
      id: "bgg",
      search: async () => {
        throw new SourceUnavailableError("BGG said 500")
      },
    }
    const type = wantjudgeType({ page, bgg })
    const read = outcomeOf(await type.prepare?.(ctx({ also: [BGG] }, null)))
    expect(read.notify?.text).toContain("I could read no listings from")
    expect(read.notify?.text).toContain("BGG said 500")
    expect(read.followUp).toEqual({})
    const state = read.state as { pending: unknown[]; places: Record<string, { misses: number }> }
    expect(state.pending).toHaveLength(1)
    expect(state.places["bgg:300580"]?.misses).toBe(1)
  })

  it("keeps each place's own looks through the model's look, so Shopify's floor holds", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const shopify = stub("shopify", () => [copy("s", 40, "https://store.example/products/s")])
    const type = wantjudgeType({ page, shopify })
    const config = { also: [{ source: "shopify", target: "curse rougarou", everyHours: 24 }] }
    const read = outcomeOf(await type.prepare?.(ctx(config, null)))
    expect(shopify.reads).toHaveLength(1)
    const state = read.state as { places: Record<string, { lastAt?: string }> }
    expect(state.places["shopify:curse rougarou"]?.lastAt).toBe(NOW.toISOString())
    const out = await type.finish?.(
      ctx(config, state, FOLLOW_UP),
      success(verdicts([1, "match"], [2, "match"])),
    )
    const after = out?.state as { places?: Record<string, { lastAt?: string }> }
    expect(after.places?.["shopify:curse rougarou"]?.lastAt).toBe(NOW.toISOString())
    // An hour later the page is read again, Shopify is not.
    const later = new Date(NOW.getTime() + 3_600_000)
    await type.prepare?.(ctx(config, after, later.toISOString(), later))
    expect(page.reads).toHaveLength(2)
    expect(shopify.reads).toHaveLength(1)
  })

  it("retries a failed look with its listings and places kept, then sends them unchecked", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const e = ebay([ebayItem(1, 20)])
    const type = wantjudgeType({ page, ebay: e.s })
    const config = { also: [EBAY] }
    let state = outcomeOf(await type.prepare?.(ctx(config, null))).state
    const failure = { kind: "error", detail: "eBay 1 by seller_a" } as JobResult
    let out: Outcome | undefined
    for (let i = 0; i < 5 && !out?.notify; i++) {
      out = await type.finish?.(ctx(config, state, FOLLOW_UP), failure)
      if (!out?.notify) {
        const s = out?.state as { failures: number; pending: unknown[]; held: unknown[] }
        expect(s.pending).toHaveLength(1)
        expect(s.held).toHaveLength(1)
        // With an eBay place the runner's detail, which can quote a listing, is not kept.
        expect(out?.summary).not.toContain("seller_a")
        state = out?.state
      }
    }
    const text = out?.notify?.text ?? ""
    expect(text).toContain("2 new listings, unchecked")
    expect(text).toContain("<https://www.ebay.com/itm/100001>")
    expect(out?.findings?.map((f) => f.source)).toEqual(["https://shop.example/p/a"])
  })

  it("asks the model nothing when every place is closed, and opens no page", async () => {
    const shopify = stub("shopify", () => [copy("s", 40, "https://store.example/products/s")])
    const e = ebay([ebayItem(1, 20)])
    const type = wantjudgeType({ shopify, ebay: e.s })
    const config = { source: "shopify", target: "curse rougarou", also: [EBAY] }
    const state = outcomeOf(await type.prepare?.(ctx(config, null))).state
    const job = (await type.prepare?.(ctx(config, state, FOLLOW_UP))) as JobSpec
    expect(job.allowedTools).toEqual([])
    expect(job.disallowedTools).toContain("WebFetch")
  })

  it("lets a held eBay listing the model said nothing of go, to be judged afresh", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const e = ebay([ebayItem(1, 20)])
    const type = wantjudgeType({ page, ebay: e.s })
    const config = { also: [EBAY] }
    const state = outcomeOf(await type.prepare?.(ctx(config, null))).state
    const out = await type.finish?.(ctx(config, state, FOLLOW_UP), success(verdicts([1, "match"])))
    expect(out?.notify?.text).toContain("Rougarou: a new listing worth a look.")
    expect(out?.notify?.text).not.toContain("100001")
    expect((out?.state as { reported: string[] } | undefined)?.reported).toHaveLength(1)
  })

  it("tells a listing two places list under one id once, and counts a failing first place's misses at the top", async () => {
    const shared = copy("x", 30)
    const page: Source = {
      id: "page",
      search: async () => {
        throw new SourceMiss("the shop said 503")
      },
    }
    const shopify = stub("shopify", () => [shared])
    const inbox = stub("inbox", () => [shared])
    const type = wantjudgeType({ page, shopify, inbox })
    const config = {
      also: [
        { source: "shopify", target: "rougarou" },
        { source: "inbox", target: "k" },
      ],
    }
    const read = outcomeOf(await type.prepare?.(ctx(config, null)))
    const state = read.state as {
      pending: unknown[]
      misses: number
      places?: Record<string, { misses: number }>
    }
    expect(state.pending).toHaveLength(1)
    expect(state.misses).toBe(1)
    expect(state.places?.["shopify:rougarou"]?.misses).toBe(0)
  })

  it("keeps each place's misses and looks while a failed look waits to be retried", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const shopify = stub("shopify", () => [copy("s", 40, "https://store.example/products/s")])
    const type = wantjudgeType({ page, shopify })
    const config = { also: [{ source: "shopify", target: "rougarou", everyHours: 24 }] }
    const state = outcomeOf(await type.prepare?.(ctx(config, null))).state
    const out = await type.finish?.(ctx(config, state, FOLLOW_UP), {
      kind: "error",
      detail: "x",
    } as JobResult)
    expect(out?.followUp).toBeDefined()
    const s = out?.state as { failures: number; places?: Record<string, { lastAt?: string }> }
    expect(s.failures).toBe(1)
    expect(s.places?.["shopify:rougarou"]?.lastAt).toBe(NOW.toISOString())
  })

  it("never keeps a held eBay listing as a finding or a price, even when its place was edited away", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const e = ebay([ebayItem(1, 20)])
    const type = wantjudgeType({ page, ebay: e.s })
    const state = outcomeOf(await type.prepare?.(ctx({ also: [EBAY] }, null))).state
    // The eBay place is gone from the config while its listing waits: it still keeps no data.
    const edited = { also: [BGG] }
    const out = await type.finish?.(
      ctx(edited, state, FOLLOW_UP),
      success(verdicts([1, "match"], [2, "match"])),
    )
    expect(out?.findings?.map((f) => f.source)).toEqual(["https://shop.example/p/a"])
    expect(
      (out?.state as { prices?: { p: number }[] } | undefined)?.prices?.map((x) => x.p),
    ).toEqual([30])
  })

  it("keeps the numbering it asked with when an edit leaves one place mid-look", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const e = ebay([ebayItem(1, 20)])
    const type = wantjudgeType({ page, ebay: e.s })
    const state = outcomeOf(await type.prepare?.(ctx({ also: [EBAY] }, null))).state
    // Now one place; the look's verdicts still land on the listings they were given for.
    const out = await type.finish?.(
      ctx({}, state, FOLLOW_UP),
      success(verdicts([1, "no"], [2, "match"])),
    )
    const text = out?.notify?.text ?? ""
    expect(text).toContain("a new listing worth a look (1 more did not look like it)")
    expect(text).toContain("itm/100001")
    expect(text).not.toContain("shop.example/p/a")
  })

  it("counts eBay failing to read its listings back as eBay's miss, and tells it at the usual count", async () => {
    const page = stub("page", () => [])
    const e = ebay([ebayItem(1, 20)])
    const type = wantjudgeType({ page, ebay: e.s })
    const config = { also: [EBAY] }
    let state: unknown = null
    let told: string | undefined
    for (let i = 0; i < 6 && told === undefined; i++) {
      state = outcomeOf(await type.prepare?.(ctx(config, state))).state
      e.down.on = true
      const out = outcomeOf(await type.prepare?.(ctx(config, state, FOLLOW_UP)))
      e.down.on = false
      state = out.state
      expect((state as { held: unknown[] }).held).toEqual([])
      told = out.notify?.text
    }
    expect(told).toContain("I could read no listings from")
    expect(told).toContain("eBay could not read its listings back just now")
    expect(
      (state as { places: Record<string, { misses: number }> }).places["ebay:curse rougarou"]
        ?.misses,
    ).toBeGreaterThan(1)
  })
})
