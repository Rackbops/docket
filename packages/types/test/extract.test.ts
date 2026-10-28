import { describe, expect, it } from "vitest"

import {
  extractPrice,
  MAX_PATTERN_BODY_CHARS,
  MAX_PATTERN_CHARS,
  parsePrice,
  patternProblem,
  priceFromJson,
  priceFromPattern,
} from "../src/index.js"

describe("parsePrice", () => {
  it("reads the common shapes of a price string", () => {
    expect(parsePrice("$1,299.99")).toBe(1299.99)
    expect(parsePrice("1.299,99 EUR")).toBe(1299.99)
    expect(parsePrice("49,90")).toBe(49.9)
    expect(parsePrice("USD 20")).toBe(20)
    expect(parsePrice("1 299,50")).toBe(1299.5)
    expect(parsePrice("12.345")).toBe(12345) // three digits after a separator: grouping
    expect(parsePrice("-5.00")).toBe(-5)
    expect(parsePrice("sold out")).toBeNull()
  })
})

describe("parsePrice on the audit's cases (docket#39)", () => {
  it("stops at a space unless a thousands group follows", () => {
    expect(parsePrice("$12.99 2 left")).toBe(12.99)
    expect(parsePrice("$20 50% off")).toBe(20)
    expect(parsePrice("$12.99 100 in stock")).toBe(12.99)
    expect(parsePrice("1 299")).toBe(1299)
    expect(parsePrice("1.299,99")).toBe(1299.99)
    expect(parsePrice("$1,299.99")).toBe(1299.99)
  })

  it("reads four or more digits, or three after a 0, as a decimal", () => {
    expect(parsePrice("29.0000")).toBe(29)
    expect(parsePrice("0.995")).toBe(0.995)
    // Three digits after any other whole part stay a thousands group in free text.
    expect(parsePrice("29.990")).toBe(29990)
  })

  it("reads a machine-written JSON price as a plain decimal", () => {
    expect(priceFromJson({ price: "29.990" })?.value).toBe(29.99)
    expect(priceFromJson({ price: "0.995" })?.value).toBe(0.995)
    expect(priceFromJson({ price: "29.0000" })?.value).toBe(29)
    expect(priceFromJson({ price: "1.299,99" })?.value).toBe(1299.99)
  })
})

describe("extractPrice", () => {
  it("prefers JSON-LD offers, with their currency", () => {
    const html = `<html><head>
      <script type="application/ld+json">not json at all</script>
      <script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Product","offers":[{"@type":"Offer","price":"59.00","priceCurrency":"EUR"}]}]}</script>
      <meta property="product:price:amount" content="61.00">
    </head></html>`
    expect(extractPrice(html)).toEqual({ value: 59, currency: "EUR" })
  })

  it("falls back to the product and Open Graph meta tags", () => {
    const html = `<meta property="og:title" content="Widget"/>
      <meta property="product:price:amount" content="1,049.00"/>
      <meta property="product:price:currency" content="usd"/>`
    expect(extractPrice(html)).toEqual({ value: 1049, currency: "USD" })
    expect(extractPrice(`<meta itemprop="price" content="12.5">`)).toEqual({ value: 12.5 })
  })

  it("reads a JSON body the way it reads JSON-LD", () => {
    const body = JSON.stringify({ data: { offers: [{ price: "12.50", priceCurrency: "GBP" }] } })
    expect(extractPrice(body)).toEqual({ value: 12.5, currency: "GBP" })
    expect(priceFromJson({ priceSpecification: { price: 7, priceCurrency: "CHF" } })).toEqual({
      value: 7,
      currency: "CHF",
    })
    expect(priceFromJson({ lowPrice: 3, highPrice: 9 })).toEqual({ value: 3 })
  })

  it("uses the owner's pattern over everything else, and returns null with nothing", () => {
    const html = `<span class="price">$42.00</span><meta itemprop="price" content="1">`
    expect(extractPrice(html, 'class="price">\\$([\\d.]+)')).toEqual({ value: 42 })
    expect(extractPrice(html, "[")).toBeNull() // a broken pattern is a miss, not a crash
    expect(extractPrice("<p>Coming soon</p>")).toBeNull()
  })
})

describe("the owner's pattern (docket#45)", () => {
  it("refuses a group that repeats a repeat, an invalid pattern and an overlong one", () => {
    for (const p of ["(a+)+b", "(x*)*", "(?:a|b+){2,}", "((a+))*", "(\\d+\\s*)+$", "(a+){2,5}"]) {
      expect(patternProblem(p), p).toMatch(/repeats a group that itself repeats/)
    }
    // A repeated alternation stalls as surely (the review's probes: 37 s, 75 s, 1.8 s).
    for (const p of [
      "(a|a)*b",
      "(?:\\s|&nbsp;| )*\\$(\\d+)",
      "(.|\\s)*Price: \\$(\\d+)",
      "(?:(a|b))+",
      "(a|b){3}",
    ]) {
      expect(patternProblem(p), p).toMatch(/or has a \|/)
    }
    expect(patternProblem("[")).toBe("the pattern is not a valid regular expression")
    expect(patternProblem("a".repeat(MAX_PATTERN_CHARS + 1))).toMatch(/longer than/)
  })

  it("takes the patterns owners write", () => {
    for (const p of [
      'class="price">\\$([\\d.]+)',
      "only &pound;([\\d.]+)",
      "(\\d+)\\.(\\d+)",
      "([\\d,]+)(?:\\.\\d+)?",
      "[(+*]+(\\d+)",
      "(\\(+)?(\\d+)",
      "(a+)?b",
      "(?:USD|EUR)\\s*(\\d+)",
      "(?:Price|Now):?\\s*\\$([\\d,.]+)",
      "(a+){,3}",
    ]) {
      expect(patternProblem(p), p).toBeNull()
    }
  })

  it("never runs a refused pattern, and runs a taken one on the capped length only", () => {
    const start = Date.now()
    expect(priceFromPattern(`${"a".repeat(40)}!`, "(a+)+b")).toBeNull()
    expect(priceFromPattern(" ".repeat(40), "(?:\\s|&nbsp;| )*\\$(\\d+)")).toBeNull()
    expect(Date.now() - start).toBeLessThan(100)
    const past = `${"x".repeat(MAX_PATTERN_BODY_CHARS)}price: 9`
    expect(priceFromPattern(past, "price: (\\d+)")).toBeNull()
    expect(priceFromPattern(`price: 9${past}`, "price: (\\d+)")).toEqual({ value: 9 })
  })
})
