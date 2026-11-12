import type { JobResult, Occurrence, RunContext, Task, User } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  judgeState,
  listingKey,
  parseShopCheck,
  SHOP_UNVETTED,
  type ShopCheck,
  type ShopCheckConfig,
  type ShopVet,
  shopcheckType,
  shopDomain,
  shopifySource,
  shopJob,
  shopStanding,
  vetListings,
  type WantConfig,
  wantjudgeType,
  wantlistType,
} from "../src/index.js"

/** The shop check (docket#120): Rod's decisions of 2026-11-11, one test each where it has a rule. */

const NOW = new Date("2026-11-12T00:00:00Z")
const check = (domain: string, verdict: ShopCheck["verdict"], checkedAt: string): ShopCheck => ({
  domain,
  verdict,
  reasons: verdict === "flagged" ? ["Trustpilot reviews say it never ships"] : [],
  sources: [],
  checkedAt,
})

/** A fake shop list: what it holds, and every request asked of it. */
function fakeVet(held: ShopCheck[] = [], failRequest = false) {
  const asked: { domain: string; from: { taskId: string; ownerId: string } }[] = []
  const vet: ShopVet = {
    async get(domains) {
      return new Map(held.filter((c) => domains.includes(c.domain)).map((c) => [c.domain, c]))
    },
    async request(domain, from) {
      asked.push({ domain, from })
      if (failRequest) throw new Error("store down")
    },
  }
  return { vet, asked }
}

describe("shopDomain", () => {
  it("takes the host, lower-case, without www", () => {
    expect(shopDomain("https://WWW.TradingCardGame.us/products/x?variant=1")).toBe(
      "tradingcardgame.us",
    )
    expect(shopDomain("https://store.stonemaiergames.com/p")).toBe("store.stonemaiergames.com")
  })
  it("refuses what is not a dotted public name", () => {
    for (const bad of [
      "https://10.0.0.5/p",
      "https://nas.local/p",
      "https://x.internal/p",
      "https://user:pw@shop.example/p",
      "https://shop.example:8443/p",
      "ftp://shop.example/p",
      "https://localhost/p",
      "https://www.com/p",
      "not a url",
    ])
      expect(shopDomain(bad)).toBeNull()
  })
})

describe("shopStanding", () => {
  it("is check with no check", () => {
    expect(shopStanding(undefined, NOW)).toBe("check")
  })
  it("keeps a pass and a flag for six calendar months, then checks again", () => {
    for (const v of ["ok", "flagged"] as const) {
      const c = check("a.com", v, "2026-05-12T00:00:00.000Z")
      expect(shopStanding(c, new Date("2026-11-11T23:59:59.999Z"))).toBe(v)
      expect(shopStanding(c, new Date("2026-11-12T00:00:00.000Z"))).toBe("check")
    }
  })
  it("clamps to the month's end (Aug 31 + 6 months is Feb 28)", () => {
    const c = check("a.com", "ok", "2026-08-31T00:00:00.000Z")
    expect(shopStanding(c, new Date("2027-02-27T23:59:59Z"))).toBe("ok")
    expect(shopStanding(c, new Date("2027-02-28T00:00:00Z"))).toBe("check")
  })
  it("keeps unknown for 30 days", () => {
    const c = check("a.com", "unknown", "2026-10-13T00:00:00.000Z")
    expect(shopStanding(c, new Date("2026-11-11T23:59:59.999Z"))).toBe("unknown")
    expect(shopStanding(c, new Date("2026-11-12T00:00:00.000Z"))).toBe("check")
  })
  it("checks again when the stored check is unusable or from the future", () => {
    expect(shopStanding({ ...check("a.com", "ok", "nonsense") }, NOW)).toBe("check")
    expect(shopStanding(check("a.com", "ok", "2026-12-01T00:00:00Z"), NOW)).toBe("check")
    expect(
      shopStanding(
        { ...check("a.com", "ok", "2026-11-01T00:00:00Z"), verdict: "great" } as never,
        NOW,
      ),
    ).toBe("check")
  })
})

describe("vetListings", () => {
  const l = (id: string, url: string) => ({ id, title: `Thing ${id}`, url })
  const from = { taskId: "t7", ownerId: "u1" }
  it("splits by standing, asks once per shop to check, and holds what it cannot vet", async () => {
    const { vet, asked } = fakeVet([
      check("good.com", "ok", "2026-11-01T00:00:00Z"),
      check("bad.us", "flagged", "2026-11-01T00:00:00Z"),
      check("new.shop", "unknown", "2026-11-01T00:00:00Z"),
    ])
    const out = await vetListings(
      [
        l("1", "https://good.com/a"),
        l("2", "https://bad.us/a"),
        l("3", "https://new.shop/a"),
        l("4", "https://never.seen/a"),
        l("5", "https://www.never.seen/b"),
        l("6", "https://10.1.1.1/a"),
      ],
      vet,
      NOW,
      from,
    )
    expect(out.send.map((x) => [x.id, x.shop])).toEqual([
      ["1", undefined],
      ["3", "unvetted"],
    ])
    expect(out.flagged.map((x) => x.listing.id)).toEqual(["2"])
    expect(out.held.map((x) => x.id)).toEqual(["4", "5", "6"])
    expect(asked).toEqual([{ domain: "never.seen", from }])
  })
  it("still holds when the host cannot take the request", async () => {
    const { vet } = fakeVet([], true)
    const out = await vetListings([l("1", "https://never.seen/a")], vet, NOW, from)
    expect(out.held).toHaveLength(1)
  })
})

describe("the check's Job", () => {
  it("runs one fixed search with WebSearch only", () => {
    const job = shopJob("tradingcardgame.us")
    expect(job.prompt).toContain(
      "Run exactly one web search, with exactly this query: is tradingcardgame.us a legitimate website",
    )
    expect(job.allowedTools).toEqual(["WebSearch"])
    for (const t of ["WebFetch", "Bash", "Read", "Glob", "Grep", "LS", "Write", "Edit"])
      expect(job.disallowedTools).toContain(t)
    expect(job.maxTurns).toBe(4)
    expect(job.maxBudgetUsd).toBe(0.1)
    expect(job.jsonSchema).toBeDefined()
  })
  it("parses an answer, capped and cleaned", () => {
    const c = parseShopCheck(
      {
        verdict: "flagged",
        reasons: ["a".repeat(500), 7, "", "b", "c", "d", "e", "f"],
        sources: ["https://www.trustpilot.com/review/x", "javascript:alert(1)", 3],
      },
      "x.us",
      NOW,
    )
    expect(c?.verdict).toBe("flagged")
    expect(c?.reasons).toHaveLength(5)
    expect(c?.reasons[0]?.length).toBeLessThanOrEqual(200)
    expect(c?.sources).toEqual(["https://www.trustpilot.com/review/x"])
    expect(c?.checkedAt).toBe(NOW.toISOString())
  })
  it("refuses an answer that is not one", () => {
    expect(parseShopCheck(null, "x.us", NOW)).toBeNull()
    expect(parseShopCheck({ verdict: "fine" }, "x.us", NOW)).toBeNull()
  })
})

describe("the shopcheck type", () => {
  const owner = { id: "u1", timeZone: "UTC", preferredHour: 9 } as User
  function ctx(domain: string): RunContext<ShopCheckConfig> {
    return {
      task: {
        id: "s1",
        ownerId: "u1",
        type: "shopcheck",
        title: domain,
        config: { domain },
      } as Task,
      occurrence: { id: "o1", taskId: "s1" } as Occurrence,
      owner,
      recipients: [],
      config: { domain },
      state: null,
      now: NOW,
      ports: {},
      history: { events: [], replies: [], series: [] },
    }
  }
  const ok = (out: unknown): JobResult => ({
    kind: "success",
    result: "",
    structuredOutput: out,
    durationMs: 1,
  })

  it("records a verdict and completes", async () => {
    const recorded: ShopCheck[] = []
    const type = shopcheckType({ record: async (c) => void recorded.push(c) })
    const job = await type.prepare?.(ctx("bad.us"))
    expect(job && "prompt" in job && job.prompt).toContain("is bad.us a legitimate website")
    const out = await type.finish?.(
      ctx("bad.us"),
      ok({ verdict: "flagged", reasons: ["ScamAdviser: low trust"], sources: [] }),
    )
    expect(out?.complete).toBe(true)
    expect(recorded.map((c) => [c.domain, c.verdict])).toEqual([["bad.us", "flagged"]])
  })
  it("records nothing when the Job failed or answered badly, so the listing stays held", async () => {
    const recorded: ShopCheck[] = []
    const type = shopcheckType({ record: async (c) => void recorded.push(c) })
    const failed = await type.finish?.(ctx("bad.us"), {
      kind: "usage_limit",
      detail: "limit",
      durationMs: 1,
    })
    const bad = await type.finish?.(ctx("bad.us"), ok({ verdict: "dunno" }))
    expect(failed?.complete).toBe(true)
    expect(bad?.complete).toBe(true)
    expect(recorded).toEqual([])
  })
  it("checks nothing for a config that is not a shop name", async () => {
    const type = shopcheckType({ record: async () => {} })
    const out = await type.prepare?.(ctx("10.0.0.1"))
    expect(out && "outcome" in out && out.outcome.complete).toBe(true)
  })
})

/** A Shopify answer with one listing per given shop address. */
function answer(urls: string[]): unknown {
  const products = urls.map((url, i) => ({
    id: `gid://shopify/p/${i}`,
    title: "Arkham Horror The Feast of Hemlock Vale Campaign Expansion",
    variants: [
      {
        id: `gid://shopify/ProductVariant/${i}`,
        title: "Default Title",
        url,
        price: { amount: 7355, currency: "USD" },
        availability: { available: true },
        seller: { name: `Shop ${i}` },
        condition: ["new"],
      },
    ],
  }))
  return { data: { alexandria: [{ data: { products } }] } }
}

describe("a Shopify watch with the shop list", () => {
  const QUERY = "Feast of Hemlock Vale"
  const config: WantConfig = { source: "shopify", target: QUERY }
  const owner = { id: "u1", timeZone: "America/New_York", preferredHour: 9 } as User
  function ctx(type: string, state: unknown = null): RunContext<WantConfig> {
    return {
      task: { id: "t7", ownerId: "u1", type, title: QUERY, config } as Task,
      occurrence: { id: "o1", taskId: "t7", dedupeKey: "2026-11-12T00:00:00.000Z" } as Occurrence,
      owner,
      recipients: [],
      config,
      state,
      now: NOW,
      ports: {},
      history: { events: [], replies: [], series: [] },
    }
  }
  const urls = [
    "https://good.com/p?variant=0",
    "https://tradingcardgame.us/p?variant=1",
    "https://new.shop/p?variant=2",
    "https://never.seen/p?variant=3",
  ]
  const shopify = shopifySource(async () => ({ status: 200, body: answer(urls) }))
  const shops = () =>
    fakeVet([
      check("good.com", "ok", "2026-11-01T00:00:00Z"),
      check("tradingcardgame.us", "flagged", "2026-11-01T00:00:00Z"),
      check("new.shop", "unknown", "2026-11-01T00:00:00Z"),
    ])

  it("tells the passed shop's listing, marks the unvetted one, keeps the flagged one out and holds the rest", async () => {
    const { vet, asked } = shops()
    const out = await wantlistType({ shopify }, { shops: vet }).run?.(ctx("wantlist"))
    const text = out?.notify?.text ?? ""
    expect(text).toContain("<https://good.com/p?variant=0>")
    expect(text).toContain(`- ${SHOP_UNVETTED} -- Arkham`)
    expect(text).not.toContain("tradingcardgame.us")
    expect(text).not.toContain("never.seen")
    expect(out?.summary).toContain("1 from a flagged shop, 1 held for a shop check, 2 new")
    const flagged = out?.findings?.find((f) => f.tags?.includes("shop-flagged"))
    expect(flagged?.text).toContain("not sent: tradingcardgame.us looks unsafe")
    expect(flagged?.text).toContain("never ships")
    expect(asked.map((a) => a.domain)).toEqual(["never.seen"])
    // Held and flagged are not remembered: told only the two sent.
    const reported = (out?.state as { reported?: string[] } | undefined)?.reported
    expect(reported).toEqual([
      listingKey("shopify:gid://shopify/ProductVariant/0"),
      listingKey("shopify:gid://shopify/ProductVariant/2"),
    ])
  })

  it("tells a held listing on a later look once its shop passed", async () => {
    const { vet } = shops()
    const type = wantlistType({ shopify }, { shops: vet })
    const first = await type.run?.(ctx("wantlist"))
    const held: ShopCheck[] = [check("never.seen", "ok", "2026-11-11T23:00:00Z")]
    const later = {
      ...vet,
      get: async (d: readonly string[]) => {
        const m = await vet.get(d)
        for (const c of held) m.set(c.domain, c)
        return m
      },
    }
    const second = await wantlistType({ shopify }, { shops: later }).run?.(
      ctx("wantlist", first?.state),
    )
    expect(second?.notify?.text).toContain("never.seen")
    expect(second?.notify?.text).not.toContain("good.com")
  })

  it("keeps a flagged shop's finding with a key of its own, not the told one's", async () => {
    const { vet } = shops()
    const out = await wantlistType({ shopify }, { shops: vet }).run?.(ctx("wantlist"))
    const flagged = out?.findings?.find((f) => f.tags?.includes("shop-flagged"))
    expect(flagged?.key).not.toBe(listingKey("shopify:gid://shopify/ProductVariant/1"))
  })

  it("leaves a watch on another source alone", async () => {
    const { vet, asked } = shops()
    const page = {
      id: "page" as const,
      async search() {
        return [{ id: "p1", title: QUERY, url: "https://never.seen/x" }]
      },
    }
    const out = await wantlistType({ page }, { shops: vet }).run?.({
      ...ctx("wantlist"),
      config: { source: "page", target: "https://never.seen/" },
    })
    expect(out?.notify?.text).toContain("never.seen")
    expect(asked).toEqual([])
  })

  it("is unchanged without a shop list", async () => {
    const out = await wantlistType({ shopify }).run?.(ctx("wantlist"))
    expect(out?.notify?.text).toContain("tradingcardgame.us")
  })

  it("vets before the judged watch's look, and keeps the unvetted mark for its DM", async () => {
    const { vet } = shops()
    const type = wantjudgeType({ shopify }, { shops: vet })
    const prep = await type.prepare?.(ctx("wantjudge"))
    expect(prep && "outcome" in prep).toBe(true)
    const outcome = prep && "outcome" in prep ? prep.outcome : undefined
    const pending = judgeState(outcome?.state).pending
    expect(pending.map((p) => p.url)).toEqual([
      "https://good.com/p?variant=0",
      "https://new.shop/p?variant=2",
    ])
    expect((pending[1] as { shop?: string }).shop).toBe("unvetted")
    expect(outcome?.findings?.some((f) => f.tags?.includes("shop-flagged"))).toBe(true)
  })
})
