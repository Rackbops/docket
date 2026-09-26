import { describe, expect, it } from "vitest"

import { isLane, LANES } from "../src/index.js"

describe("lanes", () => {
  it("has exactly the notify and execute lanes, in that order", () => {
    expect(LANES).toEqual(["notify", "execute"])
  })

  it("narrows lane names and rejects anything else", () => {
    expect(isLane("notify")).toBe(true)
    expect(isLane("execute")).toBe(true)
    expect(isLane("agent")).toBe(false)
    expect(isLane("")).toBe(false)
  })
})
