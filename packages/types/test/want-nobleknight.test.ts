import type { Occurrence, RunContext, Task, User } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  NEVER_EBAY,
  NOBLE_KNIGHT,
  nobleKnightProduct,
  nobleKnightSource,
  readNobleKnightCopies,
  SourceMiss,
  SourceUnavailableError,
  sourceText,
  type WantConfig,
  wantlistType,
} from "../src/index.js"
import { EDGE_UK } from "./nobleknight-fixture.js"

const URL_ = "https://www.nobleknight.com/P/2147942033"
const US = EDGE_UK.replaceAll("£", "$")

function fakeFetch(status: number, body: string) {
  const calls: { url: string; headers: Record<string, string> | undefined }[] = []
  return {
    calls,
    fetch: {
      async get(url: string, headers?: Record<string, string>) {
        calls.push({ url, headers })
        return { status, body, headers: {} }
      },
    } as never,
  }
}

describe("nobleKnightProduct", () => {
  it("reads every form of a product page into one address", () => {
    for (const raw of [
      "https://www.nobleknight.com/P/2147942033/Edge-of-the-Earth-Campaign-Expansion",
      "https://uk.nobleknight.com/P/2147942033/Edge-of-the-Earth-Campaign-Expansion?awid=1349",
      "http://nobleknight.com/P/2147942033",
      " https://www.nobleknight.com/p/2147942033/ ",
    ]) {
      expect(nobleKnightProduct(raw)).toEqual({ id: "2147942033", url: URL_ })
    }
  })

  it("refuses anything else", () => {
    for (const raw of [
      "https://www.nobleknight.com/MC/BoardGames",
      "https://www.nobleknight.com/Search?q=arkham",
      "https://nobleknight.com.evil.example/P/2147942033",
      "https://www.nobleknight.com:8443/P/2147942033",
      "https://user@www.nobleknight.com/P/2147942033",
      "ftp://www.nobleknight.com/P/2147942033",
      "not a url",
    ]) {
      expect(nobleKnightProduct(raw)).toBeNull()
    }
  })
})

describe("readNobleKnightCopies", () => {
  it("makes each copy in stock a listing, at its sale price, graded, with its note", () => {
    const copies = readNobleKnightCopies(US, "2147942033", URL_)
    expect(copies).toEqual([
      {
        id: "nobleknight:2147942033#2149237670",
        title: "Edge of the Earth Campaign Expansion -- SW (MINT/New)",
        url: URL_,
        price: 259.98,
        currency: "USD",
        condition: "SW (MINT/New)",
        seller: NOBLE_KNIGHT,
      },
      {
        id: "nobleknight:2147942033#2149681064",
        title: "Edge of the Earth Campaign Expansion -- VG+/NM (unpunched, cards sealed)",
        url: URL_,
        price: 198.62,
        currency: "USD",
        condition: "VG+/NM",
        seller: NOBLE_KNIGHT,
      },
      {
        id: "nobleknight:2147942033#2149697043",
        title: "Edge of the Earth Campaign Expansion -- Fair/NM (unpunched)",
        url: URL_,
        price: 191.4,
        currency: "USD",
        condition: "Fair/NM",
        seller: NOBLE_KNIGHT,
      },
    ])
  })

  it("names the currency its regional site shows", () => {
    expect(readNobleKnightCopies(EDGE_UK, "2147942033", URL_)?.map((c) => c.currency)).toEqual([
      "GBP",
      "GBP",
      "GBP",
    ])
  })

  it("leaves out a copy not in stock and another product's button", () => {
    const out = US.replace(
      'class="col condition-col in_stock"',
      'class="col condition-col out_of_stock"',
    )
    expect(readNobleKnightCopies(out, "2147942033", URL_)?.map((c) => c.id)).toEqual([
      "nobleknight:2147942033#2149681064",
      "nobleknight:2147942033#2149697043",
    ])
    // The related product's button (2148198707#...) further down is never a copy of this one.
    expect(US).toContain("2148198707#2149744008")
  })

  it("answers an empty list for the product with nothing in stock, and null for another page", () => {
    const none = US.replaceAll("condition-col in_stock", "condition-col out_of_stock")
    expect(readNobleKnightCopies(none, "2147942033", URL_)).toEqual([])
    expect(readNobleKnightCopies(US, "2148112695", URL_)).toBeNull()
    expect(readNobleKnightCopies("<html>Access denied</html>", "2147942033", URL_)).toBeNull()
    // A non-digit id that would still match the heading as a pattern is refused.
    expect(readNobleKnightCopies(US, "214794203.", URL_)).toBeNull()
  })

  it("answers null when a copy in stock no longer reads, so a changed layout is a miss", () => {
    const changed = US.replace("Edit quantity Condition", "Change quantity Grade")
    expect(readNobleKnightCopies(changed, "2147942033", URL_)).toBeNull()
    const noButton = US.replaceAll('id="2147942033#', 'data-sku="2147942033-')
    expect(readNobleKnightCopies(noButton, "2147942033", URL_)).toBeNull()
    const noRows = US.replaceAll("condition-col", "copy-col")
    expect(readNobleKnightCopies(noRows, "2147942033", URL_)).toBeNull()
  })

  it("says a changed layout apart from another page", async () => {
    const changed = US.replace("Edit quantity Condition", "Change quantity Grade")
    await expect(nobleKnightSource.search(URL_, fakeFetch(200, changed).fetch)).rejects.toThrow(
      "no longer reads as it did",
    )
  })
})

describe("nobleKnightSource", () => {
  it("reads the product page in its one form, never following to eBay", async () => {
    const f = fakeFetch(200, US)
    const got = await nobleKnightSource.search(
      "https://uk.nobleknight.com/P/2147942033/Edge-of-the-Earth-Campaign-Expansion",
      f.fetch,
    )
    expect(got).toHaveLength(3)
    expect(f.calls).toEqual([{ url: `${URL_}?SS=USD`, headers: { [NEVER_EBAY]: "1" } }])
    expect(got.map((c) => c.url)).toEqual([URL_, URL_, URL_])
  })

  it("counts a page still in another currency as a miss, not as copies to drop", async () => {
    await expect(nobleKnightSource.search(URL_, fakeFetch(200, EDGE_UK).fetch)).rejects.toThrow(
      "prices in GBP, not US dollars",
    )
  })

  it("counts a miss for another address, another page, a busy or a refusing site", async () => {
    await expect(
      nobleKnightSource.search(
        "https://www.nobleknight.com/MC/BoardGames",
        fakeFetch(200, US).fetch,
      ),
    ).rejects.toBeInstanceOf(SourceMiss)
    await expect(
      nobleKnightSource.search(URL_, fakeFetch(200, "<html></html>").fetch),
    ).rejects.toThrow("not the product's page")
    await expect(nobleKnightSource.search(URL_, fakeFetch(503, "").fetch)).rejects.toThrow("busy")
    await expect(nobleKnightSource.search(URL_, fakeFetch(403, "").fetch)).rejects.toBeInstanceOf(
      SourceUnavailableError,
    )
    await expect(nobleKnightSource.search(URL_, undefined)).rejects.toBeInstanceOf(SourceMiss)
  })

  it("has its own words for a watch", () => {
    expect(sourceText("nobleknight").where).toBe("Noble Knight's product page")
  })
})

describe("a nobleknight watch", () => {
  function ctx(fetch: unknown, over: Partial<WantConfig> = {}): RunContext<WantConfig> {
    return {
      task: { id: "t1", title: "Edge of the Earth" } as Task,
      occurrence: { id: "o1", taskId: "t1" } as Occurrence,
      owner: { id: "u1" } as User,
      recipients: [],
      config: { source: "nobleknight", target: URL_, ...over } as WantConfig,
      state: null,
      now: new Date("2026-11-13T19:00:00Z"),
      ports: { fetch } as RunContext<WantConfig>["ports"],
      history: { events: [], replies: [], series: [] },
    }
  }

  it("refuses a watch in a currency other than USD at once, without reading the page", async () => {
    const f = fakeFetch(200, US)
    const type = wantlistType({ nobleknight: nobleKnightSource })
    const out = await type.run(ctx(f.fetch, { currency: "gbp" }))
    expect(f.calls).toEqual([])
    expect(out.summary).toContain(
      "Noble Knight Games lists prices in USD only, so a watch in GBP never matches",
    )
    const usd = await type.run(ctx(f.fetch, { currency: "USD", maxPrice: 250 }))
    expect(usd.summary).toBe("3 listed, 2 within limits, 2 new")
  })
})
