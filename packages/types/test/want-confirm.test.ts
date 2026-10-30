import { describe, expect, it } from "vitest"
import {
  confirmListings,
  type EbayRequest,
  ebayItemRequest,
  ebaySource,
  type Listing,
  type ListingDetail,
  listingKey,
  parseEbayAnswer,
  parseEbayItem,
  type Source,
  wantlistType,
} from "../src/index.js"

/**
 * Confirm words on want-list watches (0.20.0, the Arkham pilot of rackbops-bot-plugins#368, Rod
 * 2026-10-30: "leave it out, then double check any that don't have it"): a listing whose title has
 * no `confirm` word is read in full where the source can, and then told, told marked to check, or
 * ruled out by `unconfirmed`. eBay's getItem answer here follows developer.ebay.com's getItem
 * reference (read 2026-10-30); the item itself is made up.
 */

const listing = (id: string, title: string, ref?: string): Listing => ({
  id,
  title,
  url: `https://www.ebay.com/itm/${id}`,
  price: 60,
  currency: "USD",
  ...(ref ? { ref } : {}),
})

const CAMPAIGN = listing("1", "Arkham Horror LCG Edge of the Earth Campaign Expansion")
const PLAIN = listing("2", "Arkham Horror LCG Edge of the Earth NEW sealed")
const INVESTIGATOR = listing("3", "Arkham Horror Edge of the Earth Investigator Expansion")
const BUNDLE = listing("4", "Edge of the Earth Campaign + Investigator Expansion lot")

const CONFIG = {
  source: "ebay" as const,
  target: "arkham horror edge of the earth",
  confirm: ["campaign"],
  unconfirmed: ["investigator"],
}

function stub(listings: Listing[], details: Record<string, ListingDetail | null>) {
  const read: string[] = []
  const source: Source = {
    id: "ebay",
    search: async () => listings,
    detail: async (l) => {
      read.push(l.id)
      return details[l.id] ?? null
    },
  }
  return { read, source }
}

const ctx = (config: Record<string, unknown>, state: unknown = null) =>
  ({
    task: { id: "t1", title: "Edge of the Earth" },
    occurrence: { dedupeKey: "2026-10-30T00:00:00.000Z" },
    config,
    state,
    ports: {},
    now: new Date("2026-10-30T00:00:00.000Z"),
  }) as never

type Out = {
  notify?: { text: string }
  summary: string
  state: { reported: string[] }
}

describe("confirmListings", () => {
  it("keeps a title that confirms, reads every listing once for shipping, and passes a bundle", async () => {
    const { read, source } = stub([CAMPAIGN, BUNDLE], {
      "1": { text: "x", shipping: "5.00 USD shipping" },
    })
    const out = await confirmListings([CAMPAIGN, BUNDLE], CONFIG, source)
    expect(out.kept.map((l) => l.id)).toEqual(["1", "4"])
    expect(out.kept[0]?.shipping).toBe("5.00 USD shipping")
    expect(out.unchecked.size).toBe(0)
    expect(out.ruledOut).toEqual([])
    expect(read).toEqual(["1", "4"])
  })

  it("confirms from the full listing, rules out an unconfirmed Investigator box, and marks the rest", async () => {
    const vague = listing("5", "Arkham Horror Edge of the Earth expansion")
    const { source } = stub([PLAIN, INVESTIGATOR, vague], {
      "2": { text: "Type: Campaign Expansion" },
      "3": { text: "Type: Investigator Expansion" },
      "5": { text: "Great condition, all cards present" },
    })
    const out = await confirmListings([PLAIN, INVESTIGATOR, vague], CONFIG, source)
    expect(out.kept.map((l) => l.id)).toEqual(["2", "5"])
    expect([...out.unchecked]).toEqual(["5"])
    expect(out.ruledOut.map((l) => l.id)).toEqual(["3"])
  })

  it("rules out by the full listing's words too, and marks a listing whose read failed", async () => {
    const quiet = listing("6", "Arkham Horror Edge of the Earth")
    const failed = listing("7", "Arkham Horror Edge of the Earth sealed")
    const { source } = stub([quiet, failed], {
      "6": { text: "This is the investigator expansion only" },
      "7": null,
    })
    const out = await confirmListings([quiet, failed], CONFIG, source)
    expect(out.ruledOut.map((l) => l.id)).toEqual(["6"])
    expect([...out.unchecked]).toEqual(["7"])
  })

  it("keeps every listing, as before, for a watch with no confirm words; a stored string counts", async () => {
    const { source } = stub([], {})
    const none = await confirmListings([PLAIN, INVESTIGATOR], { ...CONFIG, confirm: [] }, source)
    expect(none.kept).toHaveLength(2)
    expect(none.unchecked.size).toBe(0)
    const stored = await confirmListings(
      [PLAIN],
      { ...CONFIG, confirm: "campaign" as unknown as string[] },
      source,
    )
    expect([...stored.unchecked]).toEqual(["2"])
  })

  it("reads nothing where the source has no detail, and still rules out by the title", async () => {
    const source: Source = { id: "shopify", search: async () => [] }
    const out = await confirmListings([CAMPAIGN, PLAIN, INVESTIGATOR], CONFIG, source)
    expect(out.kept.map((l) => l.id)).toEqual(["1", "2"])
    expect([...out.unchecked]).toEqual(["2"])
    expect(out.ruledOut.map((l) => l.id)).toEqual(["3"])
  })
})

describe("the wantlist type with confirm words", () => {
  it("DMs a confirmed listing plainly, marks one to check, shows shipping, and remembers the ruled-out one", async () => {
    const { source } = stub([CAMPAIGN, PLAIN, INVESTIGATOR], {
      "1": { text: "", shipping: "free shipping" },
      "2": { text: "nothing useful" },
      "3": { text: "Investigator Expansion" },
    })
    const type = wantlistType({ ebay: source })
    const out = (await type.run(ctx(CONFIG))) as Out
    const lines = out.notify?.text.split("\n") ?? []
    expect(lines[0]).toBe("Edge of the Earth: 2 new listings.")
    expect(lines[1]).toContain("Campaign Expansion -- 60.00 USD -- free shipping")
    expect(lines[1]).not.toContain("check:")
    expect(lines[2]).toMatch(/^- check: not confirmed as "campaign" -- Arkham Horror LCG Edge/)
    expect(out.notify?.text).not.toContain("Investigator")
    expect(out.summary).toBe(
      "3 listed, 3 within limits, 1 not confirmed and ruled out, 1 to check, 2 new",
    )
    expect(out.state.reported).toEqual([listingKey("3"), listingKey("1"), listingKey("2")])
  })

  it("does not read a listing again once it was ruled out", async () => {
    const { read, source } = stub([INVESTIGATOR], { "3": { text: "Investigator Expansion" } })
    const type = wantlistType({ ebay: source })
    const first = (await type.run(ctx(CONFIG))) as Out
    expect(first.notify).toBeUndefined()
    expect(first.summary).toBe("1 listed, 1 within limits, 1 not confirmed and ruled out, 0 new")
    const second = (await type.run(ctx(CONFIG, first.state))) as Out
    expect(second.summary).toBe("1 listed, 1 within limits, 0 new")
    expect(read).toEqual(["3"])
  })
})

describe("eBay's full listing", () => {
  const ITEM = {
    itemId: "v1|123456789012|0",
    title: "Arkham Horror Edge of the Earth",
    shortDescription: "Sealed copy",
    localizedAspects: [
      { type: "STRING", name: "Game Title", value: "Edge of the Earth Campaign Expansion" },
      { type: "STRING", name: "Brand", value: "Fantasy Flight Games" },
    ],
    description: "<p>Ships fast.<script>alert(1)</script></p><b>Never played</b>",
    shippingOptions: [{ shippingCost: { value: "7.50", currency: "USD" } }],
  }

  it("asks getItem for a well-formed item id only", () => {
    expect(ebayItemRequest("v1|123456789012|0")).toEqual({
      path: "/buy/browse/v1/item/v1%7C123456789012%7C0",
      params: {},
      marketplace: "EBAY_US",
    })
    expect(ebayItemRequest("v1|123|0")).toBeNull()
    expect(ebayItemRequest("../../identity/v1/oauth2/token")).toBeNull()
    expect(ebayItemRequest("v1|123456789012|0?x=1")).toBeNull()
  })

  it("reads item specifics, descriptions and shipping as text, without markup or scripts", () => {
    const d = parseEbayItem(ITEM)
    expect(d?.text).toContain("Game Title: Edge of the Earth Campaign Expansion")
    expect(d?.text).toContain("Sealed copy")
    expect(d?.text).toContain("Never played")
    expect(d?.text).not.toContain("<")
    expect(d?.text).not.toContain("alert")
    expect(d?.shipping).toBe("7.50 USD shipping")
    const free = parseEbayItem({
      ...ITEM,
      shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
    })
    expect(free?.shipping).toBe("free shipping")
    expect(parseEbayItem({ ...ITEM, shippingOptions: undefined })?.shipping).toBeUndefined()
    expect(parseEbayItem({ title: "no id" })).toBeNull()
  })

  it("keeps each search result's item id as its ref, and the source reads it through the host", async () => {
    const [l] = parseEbayAnswer(
      {
        total: 1,
        itemSummaries: [
          {
            itemId: "v1|123456789012|0",
            title: "Arkham Horror Edge of the Earth",
            price: { value: "60.00", currency: "USD" },
            itemWebUrl: "https://www.ebay.com/itm/123456789012",
          },
        ],
      },
      "arkham horror edge of the earth",
    )
    expect(l?.ref).toBe("v1|123456789012|0")
    const asked: EbayRequest[] = []
    const ok = ebaySource(async (r) => {
      asked.push(r)
      return { status: 200, body: ITEM }
    })
    expect((await ok.detail?.(l as Listing))?.shipping).toBe("7.50 USD shipping")
    expect(asked[0]?.path).toBe("/buy/browse/v1/item/v1%7C123456789012%7C0")
    const gone = ebaySource(async () => ({ status: 404, body: null }))
    expect(await gone.detail?.(l as Listing)).toBeNull()
    const down = ebaySource(async () => {
      throw new Error("eBay could not be reached")
    })
    expect(await down.detail?.(l as Listing)).toBeNull()
    expect(await ok.detail?.({ ...(l as Listing), ref: undefined } as never)).toBeNull()
  })
})
