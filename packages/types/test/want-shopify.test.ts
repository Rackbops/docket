import type { Occurrence, RunContext, Task, User } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  judgeHosts,
  judgeJob,
  matchesWords,
  parseShopifyAnswer,
  renderWant,
  SHOPIFY_CAPABILITY,
  SHOPIFY_PROVIDER,
  type ShopifyRequest,
  SourceMiss,
  SourceUnavailableError,
  searchWords,
  shopifyRequest,
  shopifySource,
  type WantConfig,
  wantlistType,
} from "../src/index.js"

/**
 * The Shopify source (0.12.0). `answer()` is cut down from a real Firecrawl answer to
 * `catalog/search_catalog` for "Wingspan Oceania expansion" (country US, currency USD, available
 * only), captured 2026-10-19: descriptions, media, metadata and policy links dropped, ids, titles,
 * addresses, prices, availability, sellers and conditions kept as they came. The non-matching and
 * used products are added by hand to test the filters.
 */

type Variant = Record<string, unknown>
function variant(over: Variant = {}): Variant {
  return {
    id: "gid://shopify/ProductVariant/32581868912721",
    title: "Wingspan: Oceania Expansion",
    url: "https://store.stonemaiergames.com/products/wingspan-oceania-expansion?variant=32581868912721&_gsid=VfypsRRc2W6q&utm_source=shopify&utm_medium=catalog",
    price: { amount: 3200, currency: "USD" },
    list_price: { amount: 3500, currency: "USD" },
    availability: { available: true },
    seller: { id: "gid://shopify/Shop/9003540", name: "Stonemaier Games" },
    condition: ["new"],
    ...over,
  }
}

function answer(products: unknown[]): unknown {
  return {
    success: true,
    data: {
      alexandria: [
        {
          provider: "shopify",
          capability: "catalog/search_catalog",
          data: { products, messages: [], pagination: { has_next_page: true, total_count: 180 } },
          records: products.length,
          upstreamStatus: 200,
        },
      ],
      creditsCost: 5,
    },
  }
}

const STONEMAIER = {
  id: "gid://shopify/p/6iQh8V97oDzeCj9Pe4mOVx",
  title: "Wingspan: Oceania Expansion",
  variants: [variant()],
}
const BARNES = {
  id: "gid://shopify/p/7IBExfjteuGcaOupe90002",
  title: "Wingspan: Oceania Expansion by Elizabeth Hargrave",
  variants: [
    variant({
      id: "gid://shopify/ProductVariant/46472777662705",
      title: "Wingspan: Oceania Expansion by Elizabeth Hargrave",
      url: "https://shop.barnesandnoble.com/products/0644216628322?variant=46472777662705&_gsid=VfypsRRc2W6q&utm_source=shopify&utm_medium=catalog",
      price: { amount: 3700, currency: "USD" },
      list_price: undefined,
      seller: { id: "gid://shopify/Shop/67454337265", name: "Barnes & Noble" },
    }),
  ],
}
const BASE_GAME = {
  id: "gid://shopify/p/base",
  title: "Wingspan (base game)",
  variants: [variant({ id: "gid://shopify/ProductVariant/1", url: "https://shop.example/p/base" })],
}

const QUERY = "Wingspan Oceania expansion"

describe("shopifyRequest", () => {
  it("asks for in-stock products in USD from US stores, the top price in cents", () => {
    expect(shopifyRequest({ query: QUERY, maxPrice: 35.5 })).toEqual({
      provider: SHOPIFY_PROVIDER,
      capability: SHOPIFY_CAPABILITY,
      options: {
        query: QUERY,
        country: "US",
        currency: "USD",
        limit: 50,
        filters: { available: true, price: { max: 3550 } },
      },
    })
  })

  it("counts a top price in the currency's own minor units, and skips a top price that is not a price", () => {
    expect(shopifyRequest({ query: QUERY, maxPrice: 5000, currency: "jpy" }).options).toMatchObject(
      {
        currency: "JPY",
        filters: { price: { max: 5000 } },
      },
    )
    expect(
      shopifyRequest({ query: QUERY, maxPrice: 1.5, currency: "KWD" }).options.filters,
    ).toEqual({
      available: true,
      price: { max: 1500 },
    })
    expect(shopifyRequest({ query: QUERY, maxPrice: Number.NaN }).options.filters).toEqual({
      available: true,
    })
    expect(shopifyRequest({ query: QUERY, currency: "dollars" }).options.currency).toBe("USD")
  })

  it("sends a long search cut at a word, and asks titles for only the words sent", () => {
    const long = `${"wingspan ".repeat(30)}oceania`
    const q = shopifyRequest({ query: long }).options.query
    expect(q.length).toBeLessThanOrEqual(200)
    expect(q.endsWith("wingspan")).toBe(true)
    expect(searchWords(long)).toEqual(["wingspan"])
  })

  it("leaves the price filter out without a top price, and asks in the watch's currency", () => {
    const r = shopifyRequest({ query: QUERY, currency: "CAD" })
    expect(r.options.filters).toEqual({ available: true })
    expect(r.options.currency).toBe("CAD")
  })
})

describe("searchWords and matchesWords", () => {
  it("needs every word, whole and in any order, ignoring case and punctuation", () => {
    const words = searchWords(QUERY)
    expect(words).toEqual(["wingspan", "oceania", "expansion"])
    expect(matchesWords("Wingspan: Oceania Expansion", words)).toBe(true)
    expect(matchesWords("Oceania Expansion for WINGSPAN!", words)).toBe(true)
    expect(matchesWords("Wingspan (base game)", words)).toBe(false)
    expect(matchesWords("Wingspan Oceanian Expansions", words)).toBe(false)
    expect(matchesWords("Pokémon TCG", searchWords("pokemon tcg"))).toBe(true)
    expect(matchesWords(`${"x ".repeat(100)}Wingspan Oceania Expansion`, words)).toBe(true)
  })
})

describe("parseShopifyAnswer", () => {
  it("reads each matching product's available new variants, with price, store and a clean address", () => {
    expect(parseShopifyAnswer(answer([STONEMAIER, BARNES, BASE_GAME]), QUERY)).toEqual([
      {
        id: "shopify:gid://shopify/ProductVariant/32581868912721",
        title: "Wingspan: Oceania Expansion",
        url: "https://store.stonemaiergames.com/products/wingspan-oceania-expansion?variant=32581868912721",
        price: 32,
        currency: "USD",
        condition: "new",
        seller: "Stonemaier Games",
      },
      {
        id: "shopify:gid://shopify/ProductVariant/46472777662705",
        title: "Wingspan: Oceania Expansion by Elizabeth Hargrave",
        url: "https://shop.barnesandnoble.com/products/0644216628322?variant=46472777662705",
        price: 37,
        currency: "USD",
        condition: "new",
        seller: "Barnes & Noble",
      },
    ])
  })

  it("drops a variant that is sold out, used, or has no usable address, and repeats", () => {
    const product = {
      title: "Wingspan: Oceania Expansion",
      variants: [
        variant({ id: "a", availability: { available: false } }),
        variant({ id: "b", condition: ["used"] }),
        variant({ id: "b2", condition: ["refurbished", "new"] }),
        variant({ id: "b3", condition: [{ label: "Used" }] }),
        variant({ id: "c", url: "javascript:alert(1)" }),
        variant({ id: "d", url: "/relative" }),
        variant({ id: "e" }),
        variant({ id: "e" }),
      ],
    }
    expect(parseShopifyAnswer(answer([product]), QUERY).map((l) => l.id)).toEqual(["shopify:e"])
  })

  it("names a variant that is a version of its own, but not Shopify's Default Title", () => {
    const product = {
      title: "Wingspan: Oceania Expansion",
      variants: [
        variant({ id: "x", title: "Deluxe" }),
        variant({ id: "y", title: "Default Title" }),
      ],
    }
    expect(parseShopifyAnswer(answer([product]), QUERY).map((l) => l.title)).toEqual([
      "Wingspan: Oceania Expansion (Deluxe)",
      "Wingspan: Oceania Expansion",
    ])
  })

  it("reads a zero-decimal currency's amount as whole units", () => {
    const product = {
      title: "Wingspan Oceania Expansion",
      variants: [variant({ price: { amount: 4800, currency: "JPY" } })],
    }
    expect(parseShopifyAnswer(answer([product]), QUERY)[0]).toMatchObject({
      price: 4800,
      currency: "JPY",
    })
  })

  it("keeps a listing without a price, and an empty search as no listings", () => {
    const product = { title: "Wingspan Oceania Expansion", variants: [variant({ price: "free" })] }
    const [l] = parseShopifyAnswer(answer([product]), QUERY)
    expect(l?.price).toBeUndefined()
    expect(parseShopifyAnswer(answer([]), QUERY)).toEqual([])
  })

  it("counts a body that is not a search result, or a failed capability, as a miss", () => {
    expect(() => parseShopifyAnswer(null, QUERY)).toThrow(SourceMiss)
    expect(() => parseShopifyAnswer({ data: { alexandria: [] } }, QUERY)).toThrow(SourceMiss)
    expect(() =>
      parseShopifyAnswer(
        { data: { alexandria: [{ error: { code: "UPSTREAM_TIMEOUT" } }] } },
        QUERY,
      ),
    ).toThrow("Shopify's search failed (UPSTREAM_TIMEOUT)")
  })
})

describe("shopifySource", () => {
  function scrape(status: number, body: unknown) {
    const asked: ShopifyRequest[] = []
    return {
      asked,
      source: shopifySource(async (r) => {
        asked.push(r)
        return { status, body }
      }),
    }
  }

  it("searches the target's words with the watch's limits", async () => {
    const { asked, source } = scrape(200, answer([STONEMAIER]))
    const got = await source.search(QUERY, undefined, { maxPrice: 40, currency: "USD" })
    expect(got).toHaveLength(1)
    expect(asked[0]?.options).toMatchObject({ query: QUERY, filters: { price: { max: 4000 } } })
  })

  it("tells a bad key or no credits apart from a busy or failed search", async () => {
    await expect(scrape(401, null).source.search(QUERY, undefined)).rejects.toThrow(
      SourceUnavailableError,
    )
    await expect(scrape(402, null).source.search(QUERY, undefined)).rejects.toThrow(
      "out of credits",
    )
    const busy = scrape(503, null).source.search(QUERY, undefined)
    await expect(busy).rejects.toThrow(SourceMiss)
    await expect(busy).rejects.not.toThrow(SourceUnavailableError)
    const thrown = shopifySource(async () => {
      throw new Error("timed out")
    }).search(QUERY, undefined)
    await expect(thrown).rejects.toThrow("Shopify could not be searched: timed out")
  })

  it("makes no request without words to search for", async () => {
    const { asked, source } = scrape(200, answer([]))
    await expect(source.search("  ---  ", undefined)).rejects.toThrow(SourceMiss)
    expect(asked).toEqual([])
  })
})

describe("a Shopify watch", () => {
  const config: WantConfig = { source: "shopify", target: QUERY, maxPrice: 35 }
  const owner = { id: "u1", timeZone: "America/New_York", preferredHour: 9 } as User
  const task = { id: "t7", ownerId: "u1", type: "wantlist", title: QUERY, config } as Task
  function ctx(state: unknown = null): RunContext<WantConfig> {
    return {
      task,
      occurrence: { id: "o1", taskId: "t7" } as Occurrence,
      owner,
      recipients: [],
      config,
      state,
      now: new Date("2026-10-19T15:00:00Z"),
      ports: {},
      history: { events: [], replies: [], series: [] },
    }
  }

  it("DMs the new copies at or under the top price, via Shopify, once", async () => {
    const type = wantlistType({
      shopify: shopifySource(async () => ({ status: 200, body: answer([STONEMAIER, BARNES]) })),
    })
    const first = await type.run(ctx())
    expect(first.summary).toBe("2 listed, 1 within limits, 1 new")
    expect(first.notify?.text).toContain("Stonemaier Games")
    expect(first.notify?.text).toContain("(via Shopify)")
    expect(first.notify?.text).not.toContain("Barnes")
    const again = await type.run(ctx(first.state))
    expect(again.notify).toBeUndefined()
  })

  it("counts a bot without Shopify search as a miss, and says so at once", async () => {
    const out = await wantlistType({}).run(ctx())
    expect(out.summary).toContain("no Shopify search")
    expect(out.notify?.text).toContain("Shopify's store search")
  })

  it("opens no store for the judge", () => {
    const listing = parseShopifyAnswer(answer([STONEMAIER]), QUERY)
    expect(judgeHosts(listing, config)).toEqual([])
    const job = judgeJob(QUERY, config, listing)
    expect(job.allowedTools).toEqual([])
    expect(job.disallowedTools).toContain("WebFetch")
    expect(job.prompt).toContain("You cannot open any page")
    expect(renderWant(QUERY, "t7", listing, config)).toContain("(via Shopify)")
  })
})
