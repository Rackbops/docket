import { describe, expect, it } from "vitest"

import { minorUnits, money } from "../src/money.js"

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
