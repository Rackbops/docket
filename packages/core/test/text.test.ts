import { describe, expect, it } from "vitest"

import { clean } from "../src/index.js"

describe("clean", () => {
  it("cuts to max with an ellipsis", () => {
    expect(clean("hello world", 8)).toBe("hello...")
    expect(clean("hello world", 11)).toBe("hello world")
  })

  it("stays within a max too short for an ellipsis (docket#63)", () => {
    for (const max of [0, 1, 2, 3]) {
      expect(clean("hello world", max).length).toBeLessThanOrEqual(max)
    }
    expect(clean("hello world", 2)).toBe("he")
    expect(clean("hello world", 0)).toBe("")
  })
})
