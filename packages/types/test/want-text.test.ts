import { describe, expect, it } from "vitest"

import {
  judgeJob,
  SOURCE_IDS,
  SOURCE_TEXT,
  SourceMiss,
  SourceUnavailableError,
  sourceText,
} from "../src/index.js"
import { checkSearchStatus } from "../src/want-sources.js"

describe("the per-source text table (docket#68)", () => {
  it("has a row for every source, and a page's for a source it does not know", () => {
    expect(Object.keys(SOURCE_TEXT).sort()).toEqual([...SOURCE_IDS].sort())
    expect(sourceText("carrier-pigeon")).toBe(SOURCE_TEXT.page)
    expect(sourceText("constructor")).toBe(SOURCE_TEXT.page)
    expect(sourceText("__proto__")).toBe(SOURCE_TEXT.page)
  })

  it("says what each source said before the table (pinned)", () => {
    expect(SOURCE_TEXT.page).toMatchObject({
      attribution: null,
      where: null,
      missing: "such source",
      judgeWhere: "a shop page they gave",
    })
    expect(SOURCE_TEXT.inbox.where).toBe("what was sent in")
    expect(SOURCE_TEXT.bgg).toMatchObject({
      where: "BoardGameGeek",
      missing: "BoardGameGeek access",
      judgeWhere: "BoardGameGeek's marketplace",
    })
    expect(SOURCE_TEXT.shopify.missing).toBe("Shopify search (no Firecrawl key)")
    expect(SOURCE_TEXT.ebay.missing).toBe("eBay search (no eBay keys)")
  })
})

describe("checkSearchStatus (docket#68)", () => {
  const status = (n: number, extra?: Record<number, string>) => {
    try {
      checkSearchStatus(n, "Shop", "Shop refused the key", extra)
      return "ok"
    } catch (err) {
      return `${err instanceof SourceUnavailableError ? "unavailable" : err instanceof SourceMiss ? "miss" : "other"}: ${(err as Error).message}`
    }
  }

  it("maps each status the way every search source did", () => {
    expect(status(200)).toBe("ok")
    expect(status(401)).toBe("unavailable: Shop refused the key")
    expect(status(403)).toBe("unavailable: Shop refused the key")
    expect(status(402)).toBe("miss: Shop answered HTTP 402")
    expect(status(402, { 402: "out of credits" })).toBe("unavailable: out of credits")
    expect(status(429)).toBe("miss: Shop is busy (HTTP 429)")
    expect(status(503)).toBe("miss: Shop is busy (HTTP 503)")
    expect(status(404)).toBe("miss: Shop answered HTTP 404")
  })
})

describe("the judge's limits text (docket#58)", () => {
  it("names a currency only when it is a code, as the limits read it", () => {
    const prompt = (currency: string) =>
      judgeJob("a game", { source: "ebay", target: "a game", currency }, []).prompt
    expect(prompt("dollars")).not.toContain("dollars")
    expect(prompt("dollars")).toContain("any price")
    expect(prompt(" usd")).toContain("any price, in USD")
  })
})
