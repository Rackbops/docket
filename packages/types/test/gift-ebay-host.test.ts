import { GIFT_EBAY_HOST } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import { EBAY_HOST } from "../src/want-sources.js"

describe("the gift ledger's eBay hosts", () => {
  it("are the eBay source's, so a saved gift idea drops what an eBay watch would not keep", () => {
    expect(GIFT_EBAY_HOST.source).toBe(EBAY_HOST.source)
    expect(GIFT_EBAY_HOST.flags).toBe(EBAY_HOST.flags)
  })
})
