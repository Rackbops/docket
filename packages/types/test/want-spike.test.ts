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
const copy = (
  id: string,
  price: number | undefined,
  currency?: string,
  condition?: string,
): Listing => ({
  id,
  title: `Edge of the Earth -- copy ${id}`,
  url: `https://shop.example/p/${id}`,
  ...(price !== undefined ? { price } : {}),
  currency: currency ?? "USD",
  ...(condition ? { condition } : {}),
})
const point = (p: number, over: Partial<PricePoint> = {}): PricePoint => ({
  p,
  c: "USD",
  at: "2026-11-14",
  ...over,
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
    const kept = [100, 100, 100].map((p) => point(p, { at: yearAgo }))
    expect(usualPrice(kept, "USD", "", NOW)).toBeCloseTo(102, 6)
    const split = splitSpikes([copy("a", 152), copy("b", 153)], kept, NOW)
    expect(split.send.map((l) => l.id)).toEqual(["a"])
    expect(split.spikes.map((s) => s.listing.id)).toEqual(["b"])
  })

  it("comes from kept prices only: a first look holds nothing, however far apart its prices", () => {
    // A keyword can match the base game, a playmat and a collector box at once (review of #145).
    const look = [copy("a", 30), copy("b", 60), copy("c", 60), copy("d", 180)]
    expect(splitSpikes(look, [], NOW).spikes).toEqual([])
    expect(usualPrice([point(100), point(100)], "USD", "", NOW)).toBeNull()
  })

  it("weighs a listing only against prices in its own currency and condition", () => {
    const worn = [150, 160, 170].map((p) => point(p, { g: "very good" }))
    // A sealed copy at its normal price is not a spike against worn ones.
    const sealed = copy("s", 260, "USD", "SW (MINT/New)")
    expect(splitSpikes([sealed], worn, NOW).spikes).toEqual([])
    // A worn copy at 260 is.
    const dear = copy("w", 260, "USD", "Very Good")
    expect(splitSpikes([dear], worn, NOW).spikes.map((s) => Math.round(s.usual))).toEqual([160])
    expect(usualPrice(worn, "GBP", "very good", NOW)).toBeNull()
  })

  it("puts a listing that names no currency in the watch's own", () => {
    const kept = [100, 100, 100].map((p) => point(p))
    const bare: Listing = {
      id: "x",
      title: "Edge of the Earth",
      url: "https://shop.example/x",
      price: 200,
    }
    expect(splitSpikes([bare], kept, NOW).spikes).toEqual([])
    expect(splitSpikes([bare], kept, NOW, "USD").spikes.map((s) => Math.round(s.usual))).toEqual([
      100,
    ])
    expect(keepPrices([], [bare], NOW, "USD")).toEqual([point(200)])
  })

  it("never holds a listing with no price", () => {
    const kept = [100, 100, 100].map((p) => point(p))
    expect(splitSpikes([copy("d", undefined)], kept, NOW).send.map((l) => l.id)).toEqual(["d"])
  })

  it("keeps at most the newest prices, and reads only well-formed ones back", () => {
    const many = Array.from({ length: MAX_PRICES + 5 }, (_, i) => copy(`x${i}`, i + 1))
    const kept = keepPrices([], many, NOW)
    expect(kept).toHaveLength(MAX_PRICES)
    expect(kept[0]).toEqual({ p: 6, c: "USD", at: "2026-11-14" })
    expect(keepPrices([], [copy("n", 9, "USD", "Near Mint")], NOW)).toEqual([
      point(9, { g: "near mint" }),
    ])
    expect(
      readPrices([
        point(5),
        point(6, { g: "near mint" }),
        { p: 7, c: "USD", g: 3, at: "2026-11-14" },
        { p: -1, c: "USD", at: "x" },
        "no",
      ]),
    ).toEqual([point(5), point(6, { g: "near mint" })])
  })
})

describe("a watch with the spike check", () => {
  it("tells a new copy near the usual price, holds one far above it, and tells it once it falls", async () => {
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
    expect(spike?.text).toContain("copy e -- not sent: 500.00 USD is 202% of the usual 247.51 USD")
    // Its price is never kept, so it does not lift the usual price.
    expect((second.state as WantState).prices?.map((p) => p.p)).toEqual([238.5, 247.5, 323.96, 330])

    // Still at 500, it is held again, never told; its finding has the same key, so it is stored once.
    const third = await type.run(ctx(second.state))
    expect(third.notify).toBeUndefined()
    expect(third.summary).toBe("5 listed, 5 within limits, 1 held as a price spike, 0 new")
    expect(third.findings?.[0]?.key).toBe(spike?.key)

    // Down to 300, it is told.
    listings = listings.map((l) => (l.id === "e" ? copy("e", 300) : l))
    const fourth = await type.run(ctx(third.state))
    expect(fourth.summary).toBe("5 listed, 5 within limits, 1 new")
    expect(fourth.notify?.text).toContain("copy e")
  })

  it("keeps no price of a listing it could not confirm, so a cheap insert does not pull the usual price down", async () => {
    const listings = [copy("a", 300), copy("b", 310), copy("c", 320)]
    listings.push({ ...copy("i", 5), title: "Edge of the Earth insert" })
    const type = wantlistType({ page: source("page", () => listings) })
    const out = await type.run(ctx(null, { confirm: ["copy"] } as Partial<WantConfig>))
    expect((out.state as WantState).prices?.map((p) => p.p)).toEqual([300, 310, 320])
  })

  it("holds nothing for an eBay API watch, which keeps no prices to compare", async () => {
    const listings = [copy("a", 100), copy("b", 105), copy("c", 110), copy("d", 400)]
    const type = wantlistType({ ebay: source("ebay", () => listings) })
    const out = await type.run(ctx(null, { source: "ebay", target: "edge of the earth" }))
    expect(out.summary).toBe("4 listed, 4 within limits, 4 new")
    expect((out.state as WantState).prices).toBeUndefined()
  })
})
