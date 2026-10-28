import { describe, expect, it } from "vitest"

import {
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
