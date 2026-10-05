import { ExecutorUnavailableError, type Fetch, type FetchResponse } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  BGG_SPACING_MS,
  bggSource,
  bggThingUrl,
  isEbayHost,
  type Listing,
  listingsFromJsonLd,
  MAX_REPORTED,
  NEVER_EBAY,
  pageSource,
  parseBggThingId,
  parseMarketplace,
  renderWant,
  SourceMiss,
  SourceUnavailableError,
  wantState,
  withinLimits,
} from "../src/index.js"
import { BGG_THING, shopSearch } from "./want-fixtures.js"

/**
 * The want-list watcher's sources and pieces (category 2): the page source's JSON-LD reading, the
 * BGG source, and the type's limits, text and state. `/want` end to end is the tracker plugin's.
 */

const SHOP = "https://shop.example/search?q=wingspan"

type Item = { name: string; url: string; price?: number; condition?: string; seller?: string }
const OCEANIA: Item = {
  name: "Wingspan Oceania",
  url: "https://shop.example/p/oceania",
  price: 30,
  condition: "New",
  seller: "Meeple Barn",
}
const EUROPE: Item = { name: "Wingspan European", url: "/p/europe", price: 25 }
const NESTS: Item = {
  name: "Wingspan Nesting Box",
  url: "https://shop.example/p/nests",
  price: 60,
  condition: "Used",
}

function shop(items: Item[]) {
  const s = {
    items,
    status: 200,
    reads: [] as string[],
    headers: [] as (Record<string, string> | undefined)[],
    body: null as string | null,
  }
  const fetch: Fetch = {
    async get(url: string, headers?: Record<string, string>): Promise<FetchResponse> {
      s.reads.push(url)
      s.headers.push(headers)
      return { status: s.status, body: s.body ?? shopSearch(s.items), headers: {} }
    },
  }
  return { s, fetch }
}

describe("listingsFromJsonLd", () => {
  it("reads an ItemList's products with their prices, conditions and sellers, resolving relative addresses", () => {
    const got = listingsFromJsonLd(shopSearch([OCEANIA, EUROPE, NESTS]), SHOP)
    expect(got).toEqual([
      {
        id: "https://shop.example/p/oceania",
        title: "Wingspan Oceania",
        url: "https://shop.example/p/oceania",
        price: 30,
        currency: "USD",
        condition: "new",
        seller: "Meeple Barn",
      },
      {
        id: "https://shop.example/p/europe",
        title: "Wingspan European",
        url: "https://shop.example/p/europe",
        price: 25,
        currency: "USD",
      },
      {
        id: "https://shop.example/p/nests",
        title: "Wingspan Nesting Box",
        url: "https://shop.example/p/nests",
        price: 60,
        currency: "USD",
        condition: "used",
      },
    ])
  })

  it("takes a standalone product as the page itself, drops what has no name or an unsafe address, and repeats nothing", () => {
    const product = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Product", name: "A game", offers: { price: "12.50", priceCurrency: "EUR" } },
      ],
    }
    const list = {
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "ListItem",
          item: { "@type": "Product", name: "Bad", url: "javascript:alert(1)" },
        },
        { "@type": "ListItem", item: { "@type": "Product", url: "https://x.example/1" } },
        {
          "@type": "ListItem",
          item: { "@type": "Product", name: "Twice", url: "https://x.example/2#a" },
        },
        {
          "@type": "ListItem",
          item: { "@type": "Product", name: "Twice", url: "https://x.example/2#b" },
        },
      ],
    }
    const page = `<script type="application/ld+json">${JSON.stringify(product)}</script><script type="application/ld+json">${JSON.stringify(list)}</script>`
    expect(
      listingsFromJsonLd(page, "https://x.example/game#top").map((l) => [l.title, l.url, l.price]),
    ).toEqual([
      ["A game", "https://x.example/game", 12.5],
      ["Twice", "https://x.example/2", undefined],
    ])
  })

  it("finds nothing on a page without structured data, and the page source counts that as a miss", async () => {
    expect(
      listingsFromJsonLd("<html><body><div class=price>$30</div></body></html>", SHOP),
    ).toEqual([])
    const { s, fetch } = shop([])
    s.body = "<html></html>"
    await expect(pageSource.search(SHOP, fetch)).rejects.toThrow(SourceMiss)
    s.status = 503
    await expect(pageSource.search(SHOP, fetch)).rejects.toThrow("HTTP 503")
  })

  it("keeps one id for a listing whose address carries per-view parameters, and an empty search is no miss", async () => {
    const a = listingsFromJsonLd(
      shopSearch([{ name: "A", url: "/p/a?variant=2&_pos=1&_sid=abc&_ss=r&utm_source=x" }]),
      SHOP,
    )
    const b = listingsFromJsonLd(
      shopSearch([{ name: "A", url: "/p/a?variant=2&_pos=7&_sid=def&srsltid=zz" }]),
      SHOP,
    )
    expect(a[0]?.id).toBe("https://shop.example/p/a?variant=2")
    expect(b[0]?.id).toBe(a[0]?.id)
    const { s, fetch } = shop([])
    expect(await pageSource.search(SHOP, fetch)).toEqual([])
    s.body = "<html></html>"
    await expect(pageSource.search(SHOP, fetch)).rejects.toThrow(
      "no listings in the page's structured data",
    )
  })

  it("asks the host's Fetch port to refuse eBay on every page read", async () => {
    const { s, fetch } = shop([OCEANIA])
    await pageSource.search(SHOP, fetch)
    expect(s.headers[0]).toEqual({ [NEVER_EBAY]: "1" })
    await expect(pageSource.search(SHOP, undefined)).rejects.toThrow("this bot reads no pages")
  })

  it("knows eBay's hosts", () => {
    for (const h of ["ebay.com", "www.ebay.com", "ebay.co.uk", "m.ebay.de", "ebay.us", "EBAY.COM."])
      expect(isEbayHost(h)).toBe(true)
    for (const h of ["notebay.com", "ebay.example.org", "shop.example"])
      expect(isEbayHost(h)).toBe(false)
  })
})

describe("the BGG source", () => {
  it("parses a thing id from a bare id or a BGG address, and nothing else", () => {
    expect(parseBggThingId("300580")).toBe(300580)
    expect(
      parseBggThingId("https://boardgamegeek.com/boardgameexpansion/300580/wingspan-oceania"),
    ).toBe(300580)
    expect(parseBggThingId("https://www.boardgamegeek.com/boardgame/266192")).toBe(266192)
    for (const bad of [
      "0",
      "abc",
      "https://evil.example/boardgame/1",
      "https://boardgamegeek.com/user/1",
      "ftp://boardgamegeek.com/boardgame/1",
    ]) {
      expect(parseBggThingId(bad)).toBeNull()
    }
    expect(bggThingUrl(300580)).toBe(
      "https://boardgamegeek.com/xmlapi2/thing?id=300580&marketplace=1",
    )
  })

  it("reads the (hand-written) marketplace fixture: price, currency, condition and link, dropping an unsafe link", () => {
    expect(parseMarketplace(BGG_THING)).toEqual([
      {
        id: "bgg:https://boardgamegeek.com/geekmarket/product/4100001",
        title: "Wingspan: Oceania Expansion",
        url: "https://boardgamegeek.com/geekmarket/product/4100001",
        price: 32,
        currency: "USD",
        condition: "likenew",
      },
      {
        id: "bgg:https://boardgamegeek.com/geekmarket/product/4100002",
        title: "Wingspan: Oceania Expansion",
        url: "https://boardgamegeek.com/geekmarket/product/4100002",
        price: 29.5,
        currency: "EUR",
        condition: "new",
      },
    ])
    expect(
      parseMarketplace('<items><item><name type="primary" value="X"/></item></items>'),
    ).toEqual([])
  })

  it("sends the token to the bare host, puts back a read due within 5 s of the last, and maps BGG's refusals", async () => {
    let now = 1_000_000
    const asked: { url: string; headers: Record<string, string> | undefined }[] = []
    let status = 200
    const fetch: Fetch = {
      async get(url, headers) {
        asked.push({ url, headers })
        return { status, body: BGG_THING, headers: {} }
      },
    }
    const source = bggSource({ token: "tok", fetch, now: () => now })
    expect(await source.search("300580", undefined)).toHaveLength(2)
    expect(asked[0]).toEqual({
      url: bggThingUrl(300580),
      headers: expect.objectContaining({ authorization: "Bearer tok" }),
    })
    // Within the spacing: requeued for the next tick (docket's ExecutorUnavailableError), not waited on, not a miss.
    const soon = source.search("https://boardgamegeek.com/boardgame/266192/x", undefined)
    await expect(soon).rejects.toThrow(ExecutorUnavailableError)
    await expect(soon).rejects.not.toThrow(SourceMiss)
    expect(asked).toHaveLength(1)
    now += BGG_SPACING_MS
    expect(
      await source.search("https://boardgamegeek.com/boardgame/266192/x", undefined),
    ).toHaveLength(2)
    expect(asked[1]?.url).toBe(bggThingUrl(266192))
    const next = async () => {
      now += BGG_SPACING_MS
      return source.search("300580", undefined)
    }
    status = 401
    await expect(next()).rejects.toThrow(SourceUnavailableError)
    status = 202
    const busy = next()
    await expect(busy).rejects.toThrow("BGG is busy (HTTP 202)")
    await expect(busy).rejects.not.toThrow(SourceUnavailableError)
    status = 302
    await expect(next()).rejects.toThrow("BGG answered HTTP 302")
  })

  it("puts back a read while another is in flight", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const fetch: Fetch = {
      async get() {
        await gate
        return { status: 200, body: BGG_THING, headers: {} }
      },
    }
    let now = 0
    const source = bggSource({ token: "t", fetch, now: () => now })
    const held = source.search("1", undefined)
    now += 60_000
    await expect(source.search("1", undefined)).rejects.toThrow("waits for the next tick")
    release()
    expect(await held).toHaveLength(2)
  })

  it("parses a hostile 3 MB answer in linear time, and names the thing by its primary name", () => {
    const hostile = `<items><item><name type="alternate" value="Other"/><name type="primary" value="Real"/><marketplacelistings>${"<listing></listing>".repeat(160_000)}</marketplacelistings></item></items>`
    const t0 = performance.now()
    expect(parseMarketplace(hostile)).toEqual([])
    expect(performance.now() - t0).toBeLessThan(1500)
    const named = parseMarketplace(
      BGG_THING.replace(
        '<name type="primary" sortindex="1" value="Wingspan: Oceania Expansion" />',
        '<name type="alternate" value="Ozeanien" /><name type="primary" value="Wingspan: Oceania Expansion" />',
      ),
    )
    expect(named[0]?.title).toBe("Wingspan: Oceania Expansion")
  })
})

describe("the wantlist type's pieces", () => {
  const l = (id: string, price?: number, currency?: string): Listing => ({
    id,
    title: id,
    url: `https://x.example/${id}`,
    ...(price !== undefined ? { price } : {}),
    ...(currency ? { currency } : {}),
  })

  it("keeps listings within the limits: an unknown price never passes a top price, another currency never passes", () => {
    const cfg = { source: "page" as const, target: SHOP, maxPrice: 30, currency: "USD" }
    expect(withinLimits(l("a", 30, "USD"), cfg)).toBe(true)
    expect(withinLimits(l("b", 31, "USD"), cfg)).toBe(false)
    expect(withinLimits(l("c"), cfg)).toBe(false)
    expect(withinLimits(l("d", 10, "EUR"), cfg)).toBe(false)
    expect(withinLimits(l("e", 10), cfg)).toBe(true)
    expect(withinLimits(l("f"), { source: "page", target: SHOP })).toBe(true)
  })

  it("breaks any address in a shop's text, so only the listing's own link is a link", () => {
    const text = renderWant(
      "W",
      "t1",
      [
        {
          id: "a",
          title: "Deal https://phish.example/x www.phish.example",
          url: "https://x.example/a",
          seller: "see http://y.example",
        },
      ],
      { source: "page", target: SHOP },
    )
    expect(text).not.toContain("https://phish")
    expect(text).not.toContain("http://y")
    expect(text).not.toContain("www.phish")
    expect(text).toContain("<https://x.example/a>")
  })

  it("shows five lines and says how many more, and BGG's lines name BGG", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((id) => l(id, 1, "USD"))
    const text = renderWant("Wingspan", "t9", many, { source: "bgg", target: "1" })
    expect(text.split("\n").filter((x) => x.startsWith("- "))).toHaveLength(5)
    expect(text).toContain("(via BoardGameGeek)")
    expect(text).toContain("...and 2 more: `/task history t9` lists them all.")
  })

  it("reads back a state, capped, and a broken one as fresh", () => {
    expect(wantState(null)).toEqual({ reported: [], misses: 0, told: 0, warned: false })
    expect(
      wantState({
        reported: Array.from({ length: MAX_REPORTED + 5 }, (_, i) => `k${i}`),
        misses: 2,
        told: 7,
      }).reported,
    ).toHaveLength(MAX_REPORTED)
  })
})
