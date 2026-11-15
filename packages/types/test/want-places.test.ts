import type { Occurrence, RunContext, Task, User } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  type Listing,
  MAX_EXTRA_PLACES,
  ONE_PLACE,
  placeDue,
  readPlaceStates,
  type Source,
  type SourceId,
  SourceMiss,
  SourceUnavailableError,
  type WantConfig,
  wantjudgeType,
  wantlistType,
  wantPlaces,
} from "../src/index.js"

/**
 * One watch, several places (Rod, 2026-11-15: "This should be check boxes for multiple
 * selections"): `also` beside the first place, each read as a one-place watch, one DM.
 */

const NOW = new Date("2026-11-15T22:00:00Z")

const copy = (id: string, price: number, url = `https://shop.example/p/${id}`): Listing => ({
  id,
  title: `Curse of the Rougarou -- ${id}`,
  url,
  price,
  currency: "USD",
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

function ctx(
  config: Partial<WantConfig> & Record<string, unknown>,
  state: unknown = null,
  now = NOW,
  dedupeKey = now.toISOString(),
): RunContext<WantConfig> {
  return {
    task: { id: "t1", title: "Rougarou" } as Task,
    occurrence: { id: "o1", taskId: "t1", dedupeKey } as Occurrence,
    owner: { id: "u1" } as User,
    recipients: [],
    config: { source: "page", target: "https://shop.example/s", ...config } as WantConfig,
    state,
    now,
    ports: {},
    history: { events: [], replies: [], series: [] },
  }
}

const EBAY = { source: "ebay", target: "curse rougarou" } as const

describe("a watch's places", () => {
  it("is its one place when it has no also, as every watch made before", () => {
    expect(wantPlaces({ source: "page", target: "https://a.example/" })).toEqual([
      { source: "page", target: "https://a.example/" },
    ])
    expect(wantPlaces({ source: "page", target: "https://a.example/", also: [] })).toHaveLength(1)
  })

  it("adds each readable also entry once, at most four, and drops what it cannot read", () => {
    const places = wantPlaces({
      source: "page",
      target: "https://a.example/",
      also: [
        EBAY,
        EBAY,
        { source: "page", target: "https://a.example/" },
        { source: "nowhere", target: "x" },
        { source: "bgg", target: "  " },
        { source: "bgg", target: 7 },
        "ebay",
        null,
        { source: "bgg", target: "300580", everyHours: -1 },
        { source: "shopify", target: "rougarou", everyHours: 24 },
        { source: "nobleknight", target: "https://www.nobleknight.com/P/1" },
        { source: "inbox", target: "ebay-k", search: "rougarou" },
        { source: "page", target: "https://b.example/" },
      ],
    })
    expect(places).toHaveLength(1 + MAX_EXTRA_PLACES)
    expect(places.map((p) => p.source)).toEqual(["page", "ebay", "bgg", "shopify", "nobleknight"])
    expect(places[2]).toEqual({ source: "bgg", target: "300580" })
    expect(places[3]?.everyHours).toBe(24)
  })

  it("reads stored place states defensively", () => {
    expect(readPlaceStates(null)).toEqual({})
    expect(readPlaceStates({ places: [1] })).toEqual({})
    const read = readPlaceStates({
      places: {
        "ebay:x": { misses: 2, warned: true, lastAt: "2026-11-15T00:00:00Z" },
        "bgg:1": { misses: -3, lastAt: "never" },
        __proto__: { misses: 9 },
        "page:y": 4,
      },
    })
    expect(read).toEqual({
      "ebay:x": { misses: 2, warned: true, lastAt: "2026-11-15T00:00:00Z" },
      "bgg:1": { misses: 0, warned: false },
    })
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
  })

  it("is due unless its own hours have not passed since its last look", () => {
    const p = { source: "shopify" as const, target: "x", everyHours: 24 }
    expect(placeDue(p, undefined, NOW)).toBe(true)
    expect(placeDue(p, { misses: 0, warned: false, lastAt: "2026-11-15T00:00:00Z" }, NOW)).toBe(
      false,
    )
    expect(placeDue(p, { misses: 0, warned: false, lastAt: "2026-11-14T22:00:30Z" }, NOW)).toBe(
      true,
    )
    expect(placeDue({ source: "ebay", target: "x" }, { misses: 0, warned: false }, NOW)).toBe(true)
  })
})

describe("a look at several places", () => {
  it("reads every place and tells what each found in one DM, with Done", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const ebay = stub("ebay", () => [copy("e1", 40, "https://www.ebay.com/itm/1")])
    const out = await wantlistType({ page, ebay }).run(ctx({ also: [EBAY] }))
    expect(page.reads).toEqual(["https://shop.example/s"])
    expect(ebay.reads).toEqual(["curse rougarou"])
    expect(out.notify?.actions).toEqual(["done"])
    const lines = out.notify?.text.split("\n") ?? []
    expect(lines[0]).toBe("Rougarou: 2 new listings.")
    expect(lines[1]).toContain("<https://shop.example/p/a>")
    expect(lines[1]).not.toContain("eBay")
    expect(lines[2]).toContain("<https://www.ebay.com/itm/1> (")
    expect(lines.at(-1)).toBe("Press Done once you have it, and I stop looking.")
    // eBay keeps no data: only the page's listing is a finding.
    expect(out.findings?.map((f) => f.source)).toEqual(["https://shop.example/p/a"])
    const state = out.state as { reported: string[]; told: number }
    expect(state.reported).toHaveLength(2)
    expect(state.told).toBe(2)
    expect(out.summary).toMatch(/^https:\/\/shop.example\/s: 1 listed.*; eBay.s search: 1 listed/)
  })

  it("tells a copy two places list once, and nothing again on the next look", async () => {
    const same = copy("x", 30)
    const type = wantlistType({
      page: stub("page", () => [same]),
      bgg: stub("bgg", () => [same, copy("b", 20)]),
    })
    const first = await type.run(ctx({ also: [{ source: "bgg", target: "300580" }] }))
    expect(first.notify?.text.split("\n")[0]).toBe("Rougarou: 2 new listings.")
    const again = await type.run(ctx({ also: [{ source: "bgg", target: "300580" }] }, first.state))
    expect(again.notify).toBeUndefined()
    expect((again.state as { told: number }).told).toBe(2)
  })

  it("still tells one place's listings when another cannot be read, with that place's warning", async () => {
    const type = wantlistType({ page: stub("page", () => [copy("a", 30)]) })
    const out = await type.run(ctx({ also: [{ source: "bgg", target: "300580" }] }))
    const text = out.notify?.text ?? ""
    expect(text).toContain("Rougarou: a new listing.")
    expect(text).toContain("I could read no listings from BoardGameGeek just now")
    expect(text).toContain("I keep looking there.")
    expect(text).not.toContain("press Done to stop")
    const state = out.state as {
      misses: number
      places: Record<string, { misses: number; warned: boolean }>
    }
    expect(state.misses).toBe(0)
    expect(state.places["bgg:300580"]).toMatchObject({ misses: 1, warned: true })
    // Warned once: the next look's miss says nothing more.
    const again = await type.run(ctx({ also: [{ source: "bgg", target: "300580" }] }, out.state))
    expect(again.notify).toBeUndefined()
    expect((again.state as typeof state).places["bgg:300580"]?.misses).toBe(2)
  })

  it("DMs a place's warning alone when nothing new is found", async () => {
    let fail = false
    const ebay: Source = {
      id: "ebay",
      search: async () => {
        if (fail) throw new SourceUnavailableError("eBay refused the keys")
        return []
      },
    }
    const type = wantlistType({ page: stub("page", () => []), ebay })
    fail = true
    const out = await type.run(ctx({ also: [EBAY] }))
    expect(out.notify?.text).toBe(
      "Rougarou: I could read no listings from eBay's search just now (eBay refused the keys). I keep looking; press Done to stop.",
    )
  })

  it("counts a first place's misses where a one-place watch keeps them", async () => {
    const page: Source = {
      id: "page",
      search: async () => {
        throw new SourceMiss("shop down")
      },
    }
    const type = wantlistType({ page, ebay: stub("ebay", () => []) })
    const out = await type.run(
      ctx({ also: [EBAY] }, { reported: [], misses: 1, told: 0, warned: false }),
    )
    const state = out.state as { misses: number; places?: Record<string, unknown> }
    expect(state.misses).toBe(2)
    expect(state.places?.["page:https://shop.example/s"]).toBeUndefined()
  })

  it("skips a place until its own hours have passed", async () => {
    const shopify = stub("shopify", () => [])
    const type = wantlistType({ page: stub("page", () => []), shopify })
    const also = [{ source: "shopify", target: "rougarou", everyHours: 24 }]
    const first = await type.run(ctx({ also }))
    expect(shopify.reads).toHaveLength(1)
    const soon = new Date(NOW.getTime() + 3_600_000)
    const second = await type.run(ctx({ also }, first.state, soon))
    expect(shopify.reads).toHaveLength(1)
    expect(second.summary).toContain("Shopify's store search: not due")
    expect(
      (second.state as { places: Record<string, unknown> }).places["shopify:rougarou"],
    ).toEqual((first.state as { places: Record<string, unknown> }).places["shopify:rougarou"])
    const later = new Date(NOW.getTime() + 24 * 3_600_000)
    await type.run(ctx({ also }, second.state, later))
    expect(shopify.reads).toHaveLength(2)
  })

  it("leaves a one-place watch's run as it was", async () => {
    const make = () => wantlistType({ page: stub("page", () => [copy("a", 30), copy("b", 99)]) })
    const plain = await make().run(ctx({ maxPrice: 50 }))
    const empty = await make().run(ctx({ maxPrice: 50, also: [] }))
    const junk = await make().run(ctx({ maxPrice: 50, also: [{ source: "nowhere", target: "x" }] }))
    expect(empty).toEqual(plain)
    expect(junk).toEqual(plain)
    expect((plain.state as Record<string, unknown>).places).toBeUndefined()
  })

  it("applies the watch's limits and words at every place", async () => {
    const type = wantlistType({
      page: stub("page", () => [copy("a", 30)]),
      ebay: stub("ebay", () => [copy("e1", 80), { ...copy("e2", 20), title: "Rougarou insert" }]),
    })
    const out = await type.run(ctx({ also: [EBAY], maxPrice: 50, exclude: ["insert"] }))
    expect(out.notify?.text.split("\n")[0]).toBe("Rougarou: a new listing.")
  })

  it("is refused by a judged watch, which looks in one place", async () => {
    const page = stub("page", () => [copy("a", 30)])
    const type = wantjudgeType({ page })
    const out = await type.prepare?.(ctx({ also: [EBAY] }))
    expect(page.reads).toEqual([])
    expect(out).toMatchObject({ outcome: { summary: `nothing read: ${ONE_PLACE}` } })
    expect((out as { outcome: { notify?: { text: string } } }).outcome.notify?.text).toContain(
      ONE_PLACE,
    )
  })
})
