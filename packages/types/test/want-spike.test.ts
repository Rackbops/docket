import type { Occurrence, RunContext, Task, User } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  type Listing,
  type Source,
  type WantConfig,
  type WantState,
  wantlistType,
} from "../src/index.js"
import {
  keepPrices,
  MAX_PRICES,
  type PricePoint,
  readPrices,
  splitSpikes,
  usualPrice,
} from "../src/want-spike.js"

const NOW = new Date("2026-11-14T21:00:00Z")
const copy = (id: string, price: number | undefined, currency = "USD"): Listing => ({
  id,
  title: `Edge of the Earth -- copy ${id}`,
  url: `https://shop.example/p/${id}`,
  ...(price !== undefined ? { price } : {}),
  currency,
})

function source(id: "page" | "ebay", listings: () => Listing[]): Source {
  return { id, search: async () => listings() }
}

function ctx(state: unknown, over: Partial<WantConfig> = {}): RunContext<WantConfig> {
  return {
    task: { id: "t1", title: "Edge of the Earth" } as Task,
    occurrence: { id: "o1", taskId: "t1" } as Occurrence,
    owner: { id: "u1" } as User,
    recipients: [],
    config: { source: "page", target: "https://shop.example/s", ...over } as WantConfig,
    state,
    now: NOW,
    ports: {},
    history: { events: [], replies: [], series: [] },
  }
}

describe("the usual price", () => {
  it("raises an older price 2% a year: a price of 100 a year ago is 102 now", () => {
    const yearAgo = new Date(NOW.getTime() - 365.25 * 24 * 3600 * 1000).toISOString()
    const kept: PricePoint[] = [100, 100, 100].map((p) => ({ p, c: "USD", at: yearAgo }))
    expect(usualPrice(kept, [], "USD", NOW)).toBeCloseTo(102, 6)
    const split = splitSpikes([copy("a", 152), copy("b", 153)], [], kept, NOW)
    expect(split.send.map((l) => l.id)).toEqual(["a"])
    expect(split.spikes.map((s) => s.listing.id)).toEqual(["b"])
  })

  it("needs three prices in the listing's currency, and never holds a listing with no price", () => {
    expect(usualPrice([], [copy("a", 100), copy("b", 100)], "USD", NOW)).toBeNull()
    expect(
      usualPrice([], [copy("a", 100), copy("b", 100), copy("c", 100, "GBP")], "USD", NOW),
    ).toBeNull()
    const look = [copy("a", 100), copy("b", 100), copy("c", 100), copy("d", undefined)]
    expect(splitSpikes(look, look, [], NOW).send.map((l) => l.id)).toEqual(["a", "b", "c", "d"])
  })

  it("holds an outlier on a first look with three or more prices", () => {
    const look = [copy("a", 240), copy("b", 250), copy("c", 320), copy("d", 600)]
    const split = splitSpikes(look, look, [], NOW)
    expect(split.spikes.map((s) => [s.listing.id, s.usual])).toEqual([["d", 285]])
  })

  it("keeps at most the newest prices, and reads only well-formed ones back", () => {
    const many = Array.from({ length: MAX_PRICES + 5 }, (_, i) => copy(`x${i}`, i + 1))
    const kept = keepPrices([], many, NOW)
    expect(kept).toHaveLength(MAX_PRICES)
    expect(kept[0]).toEqual({ p: 6, c: "USD", at: "2026-11-14" })
    expect(
      readPrices([{ p: 5, c: "USD", at: "2026-11-14" }, { p: -1, c: "USD", at: "x" }, "no"]),
    ).toEqual([{ p: 5, c: "USD", at: "2026-11-14" }])
  })
})

describe("a watch with the spike check", () => {
  it("tells a new copy near the usual price and holds one far above it as a finding", async () => {
    let listings = [copy("a", 238.5), copy("b", 247.5), copy("c", 323.96)]
    const type = wantlistType({ page: source("page", () => listings) })
    const first = await type.run(ctx(null))
    expect(first.summary).toBe("3 listed, 3 within limits, 3 new")
    const state = first.state as WantState
    expect(state.prices?.map((p) => p.p)).toEqual([238.5, 247.5, 323.96])

    listings = [...listings, copy("d", 330), copy("e", 500)]
    const second = await type.run(ctx(state))
    expect(second.summary).toBe("5 listed, 5 within limits, 1 held as a price spike, 1 new")
    expect(second.notify?.text).toContain("copy d")
    expect(second.notify?.text).not.toContain("copy e")
    const spike = second.findings?.find((f) => f.tags?.includes("price-spike"))
    expect(spike?.text).toContain("copy e -- not sent: 500.00 USD is")
    expect(spike?.text).toContain("of the usual")
    // The spike is weighed once: the next look neither tells it nor holds it again.
    const third = await type.run(ctx(second.state))
    expect(third.notify).toBeUndefined()
    expect(third.summary).toBe("5 listed, 5 within limits, 0 new")
    // Its price is never kept, so it does not lift the usual price.
    expect((third.state as WantState).prices?.map((p) => p.p)).not.toContain(500)
  })

  it("keeps no prices for an eBay API watch, which compares this look's listings only", async () => {
    const listings = [copy("a", 100), copy("b", 105), copy("c", 110), copy("d", 400)]
    const type = wantlistType({ ebay: source("ebay", () => listings) })
    const out = await type.run(ctx(null, { source: "ebay", target: "edge of the earth" }))
    expect(out.summary).toContain("1 held as a price spike")
    expect((out.state as WantState).prices).toBeUndefined()
    expect(out.findings ?? []).toEqual([])
  })
})
