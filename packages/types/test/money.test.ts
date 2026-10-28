import { describe, expect, it } from "vitest"

import { currencyCode, minorUnits, money } from "../src/money.js"
import { shopifyRequest } from "../src/want-shopify.js"
import type { Listing } from "../src/want-sources.js"
import { type WantConfig, withinLimits } from "../src/wantlist.js"

describe("money (docket#61)", () => {
  it("prints each currency in its own decimals", () => {
    expect(money(15.99, "USD")).toBe("15.99 USD")
    expect(money(4000, "JPY")).toBe("4000 JPY")
    expect(money(1.234, "KWD")).toBe("1.234 KWD")
    expect(money(1.5, "kwd")).toBe("1.500 kwd")
  })

  it("prints two decimals with no unit or one it does not know", () => {
    expect(money(12.5, "")).toBe("12.50")
    expect(money(12.5, "dollars")).toBe("12.50 dollars")
    expect(minorUnits(" jpy ")).toBe(1)
  })
})

describe("currencyCode (docket#58)", () => {
  it("trims and upper-cases a three-letter code, and gives undefined for empty or invalid text", () => {
    expect(currencyCode(" usd ")).toBe("USD")
    expect(currencyCode("Eur")).toBe("EUR")
    expect(currencyCode(undefined)).toBeUndefined()
    expect(currencyCode("")).toBeUndefined()
    expect(currencyCode("   ")).toBeUndefined()
    expect(currencyCode("dollars")).toBeUndefined()
    expect(currencyCode("US")).toBeUndefined()
    expect(currencyCode("U5D")).toBeUndefined()
  })

  it("makes an invalid watch currency limit nothing, where it once dropped every listing", () => {
    const listing: Listing = {
      id: "1",
      title: "Wingspan",
      url: "https://shop.example/w",
      price: 30,
      currency: "USD",
    }
    const watch = (currency: string): WantConfig => ({ source: "shopify", target: "", currency })
    expect(withinLimits(listing, watch("dollars"))).toBe(true)
    expect(withinLimits(listing, watch("eur"))).toBe(false)
    expect(withinLimits(listing, watch(" usd"))).toBe(true)
    expect(shopifyRequest({ query: "wingspan", currency: "dollars" }).options.currency).toBe("USD")
  })
})
