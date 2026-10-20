import type { Occurrence, RunContext, Task, User } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  EBAY_MARKETPLACE,
  EBAY_SEARCH_PATH,
  type EbayRequest,
  ebayRequest,
  ebaySource,
  judgeHosts,
  judgeJob,
  parseEbayAnswer,
  renderWant,
  SOURCE_IDS,
  SourceMiss,
  SourceUnavailableError,
  type WantConfig,
  wantlistType,
} from "../src/index.js"

/**
 * The eBay source (0.13.0). The answers follow the Browse API's documented `item_summary/search`
 * response (developer.ebay.com, read 2026-10-20): `total`, and `itemSummaries` of `itemId`,
 * `title`, `price`, `condition`, `itemWebUrl`, `seller`, `buyingOptions`, `currentBidPrice`. The
 * listings themselves are made up; no eBay answer was captured (no keys here).
 */

type Item = Record<string, unknown>
function item(over: Item = {}): Item {
  return {
    itemId: "v1|123456789012|0",
    title: "Wingspan Oceania Expansion - Stonemaier Games - New Sealed",
    price: { value: "29.99", currency: "USD" },
    condition: "New",
    conditionId: "1000",
    itemWebUrl: "https://www.ebay.com/itm/123456789012?hash=item1cbe991b14:g:abc&amdata=enc%3AAQ",
    seller: { username: "boardgame_bin", feedbackPercentage: "99.6", feedbackScore: 4821 },
    buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
    ...over,
  }
}

function answer(items: Item[] | undefined): unknown {
  return items === undefined
    ? { total: 0, limit: 50, offset: 0 }
    : { total: items.length, itemSummaries: items }
}

const QUERY = "Wingspan Oceania expansion"

function browse(status: number, body: unknown) {
  const asked: EbayRequest[] = []
  const source = ebaySource(async (r) => {
    asked.push(r)
    return { status, body }
  })
  return { asked, source }
}

describe("the eBay request", () => {
  it("asks for the newest fifty, on eBay US, under the top price", () => {
    const r = ebayRequest({ query: QUERY, maxPrice: 35 })
    expect(r.path).toBe(EBAY_SEARCH_PATH)
    expect(r.marketplace).toBe(EBAY_MARKETPLACE)
    expect(r.params).toEqual({
      q: QUERY,
      limit: "50",
      sort: "newlyListed",
      filter: "price:[..35.00],priceCurrency:USD",
    })
  })

  it("leaves the price filter out with no top price, or for a watch not in USD", () => {
    expect(ebayRequest({ query: QUERY }).params.filter).toBeUndefined()
    expect(ebayRequest({ query: QUERY, maxPrice: Number.NaN }).params.filter).toBeUndefined()
    expect(
      ebayRequest({ query: QUERY, maxPrice: 4000, currency: "jpy" }).params.filter,
    ).toBeUndefined()
    expect(ebayRequest({ query: QUERY, maxPrice: 20.5, currency: "usd" }).params.filter).toBe(
      "price:[..20.50],priceCurrency:USD",
    )
    expect(
      ebayRequest({ query: QUERY, maxPrice: 20, currency: "dollars" }).params.filter,
    ).toBeUndefined()
  })

  it("is a source id", () => {
    expect(SOURCE_IDS).toContain("ebay")
  })
})

describe("the eBay answer", () => {
  it("reads a listing with its price, condition, seller and a bare item address", () => {
    const [l, ...rest] = parseEbayAnswer(answer([item()]), QUERY)
    expect(rest).toEqual([])
    expect(l).toEqual({
      id: "ebay:v1|123456789012|0",
      title: "Wingspan Oceania Expansion - Stonemaier Games - New Sealed",
      url: "https://www.ebay.com/itm/123456789012",
      price: 29.99,
      currency: "USD",
      condition: "New",
      seller: "boardgame_bin, 99.6% positive, 4821 feedback",
    })
  })

  it("prices an auction at its current bid and says it is one", () => {
    const [l] = parseEbayAnswer(
      answer([
        item({
          buyingOptions: ["AUCTION"],
          price: { value: "45.00", currency: "USD" },
          currentBidPrice: { value: "12.50", currency: "USD" },
          condition: "Used",
        }),
      ]),
      QUERY,
    )
    expect(l?.price).toBe(12.5)
    expect(l?.condition).toBe("Used, auction")
  })

  it("prices an auction with Buy It Now at that price, and says both", () => {
    const [l] = parseEbayAnswer(
      answer([
        item({
          buyingOptions: ["AUCTION", "FIXED_PRICE"],
          price: { value: "45.00", currency: "USD" },
          currentBidPrice: { value: "12.50", currency: "USD" },
        }),
      ]),
      QUERY,
    )
    expect(l?.price).toBe(45)
    expect(l?.condition).toBe("New, auction, Buy It Now")
  })

  it("keeps only titles holding every word, with an eBay item address, once each", () => {
    const out = parseEbayAnswer(
      answer([
        item({ itemId: "a", title: "Wingspan base game" }),
        item({ itemId: "b", itemWebUrl: "https://evil.example/itm/123456789012" }),
        item({ itemId: "c", itemWebUrl: "http://www.ebay.com/itm/123456789012" }),
        item({ itemId: "d", itemWebUrl: "https://www.ebay.com/sch/i.html?_nkw=wingspan" }),
        item({ itemId: "e" }),
        item({ itemId: "e" }),
        item({
          itemId: "f",
          title: "WINGSPAN: Océania Expansion",
          itemWebUrl: "https://www.ebay.co.uk/itm/Wingspan-Oceania/223344556677",
        }),
      ]),
      QUERY,
    )
    expect(out.map((l) => l.id)).toEqual(["ebay:e", "ebay:f"])
    expect(out[1]?.url).toBe("https://www.ebay.co.uk/itm/223344556677")
  })

  it("drops a price or a seller it cannot read, and keeps the listing", () => {
    const [l] = parseEbayAnswer(
      answer([
        item({
          price: { value: "lots", currency: "USD" },
          seller: { feedbackScore: 3 },
          condition: undefined,
        }),
      ]),
      QUERY,
    )
    expect(l?.price).toBeUndefined()
    expect(l?.seller).toBeUndefined()
    expect(l?.condition).toBeUndefined()
  })

  it("reads an answer with no results as none, and anything else as a miss", () => {
    expect(parseEbayAnswer(answer(undefined), QUERY)).toEqual([])
    expect(() => parseEbayAnswer({ errors: [] }, QUERY)).toThrow(SourceMiss)
    expect(() => parseEbayAnswer(null, QUERY)).toThrow(SourceMiss)
  })
})

describe("the eBay source", () => {
  it("sends the words and limits, and reads the answer", async () => {
    const { asked, source } = browse(200, answer([item()]))
    const out = await source.search(QUERY, undefined, { maxPrice: 35, currency: "USD" })
    expect(out).toHaveLength(1)
    expect(asked[0]?.params.filter).toBe("price:[..35.00],priceCurrency:USD")
  })

  it("tells the owner at once when eBay refuses the keys, and counts a busy eBay as a miss", async () => {
    await expect(browse(401, null).source.search(QUERY, undefined)).rejects.toThrow(
      SourceUnavailableError,
    )
    await expect(browse(403, null).source.search(QUERY, undefined)).rejects.toThrow(
      SourceUnavailableError,
    )
    const busy = browse(429, null).source.search(QUERY, undefined)
    await expect(busy).rejects.toThrow("eBay is busy (HTTP 429)")
    await expect(busy).rejects.not.toThrow(SourceUnavailableError)
    await expect(browse(400, null).source.search(QUERY, undefined)).rejects.toThrow("HTTP 400")
  })

  it("counts a failed request as a miss, with the host's own words", async () => {
    const source = ebaySource(async () => {
      throw new Error("eBay could not be reached")
    })
    await expect(source.search(QUERY, undefined)).rejects.toThrow(
      "eBay could not be searched: eBay could not be reached",
    )
  })

  it("makes no request without words to search for", async () => {
    const { asked, source } = browse(200, answer([]))
    await expect(source.search("  ---  ", undefined)).rejects.toThrow(SourceMiss)
    expect(asked).toEqual([])
  })
})

describe("an eBay watch", () => {
  const config: WantConfig = { source: "ebay", target: QUERY, maxPrice: 35 }
  const owner = { id: "u1", timeZone: "America/New_York", preferredHour: 9 } as User
  const task = { id: "t6", ownerId: "u1", type: "wantlist", title: QUERY, config } as Task
  function ctx(state: unknown = null): RunContext<WantConfig> {
    return {
      task,
      occurrence: { id: "o1", taskId: "t6" } as Occurrence,
      owner,
      recipients: [],
      config,
      state,
      now: new Date("2026-10-20T15:00:00Z"),
      ports: {},
      history: { events: [], replies: [], series: [] },
    }
  }

  it("DMs the new listings within the limits, via eBay, once", async () => {
    const pricey = item({ itemId: "p", price: { value: "80.00", currency: "USD" } })
    const type = wantlistType({ ebay: browse(200, answer([item(), pricey])).source })
    const first = await type.run(ctx())
    expect(first.summary).toBe("2 listed, 1 within limits, 1 new")
    expect(first.notify?.text).toContain("boardgame_bin")
    expect(first.notify?.text).toContain("(via eBay)")
    const again = await type.run(ctx(first.state))
    expect(again.notify).toBeUndefined()
  })

  it("counts a bot without eBay keys as a miss, and says so at once", async () => {
    const out = await wantlistType({}).run(ctx())
    expect(out.summary).toContain("no eBay search")
    expect(out.notify?.text).toContain("eBay's search")
  })

  it("opens no eBay page for the judge", () => {
    const listing = parseEbayAnswer(answer([item()]), QUERY)
    expect(judgeHosts(listing, config)).toEqual([])
    const job = judgeJob(QUERY, config, listing)
    expect(job.allowedTools).toEqual([])
    expect(job.disallowedTools).toContain("WebFetch")
    expect(job.prompt).toContain("You cannot open any page")
    expect(job.prompt).toContain("eBay's own API")
    expect(renderWant(QUERY, "t6", listing, config)).toContain("(via eBay)")
  })
})
