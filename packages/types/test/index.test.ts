import { isLane } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"

import { isTypeId, TYPE_IDS } from "../src/index.js"

describe("type ids", () => {
  it("names the six categories of the plan, each once", () => {
    expect(TYPE_IDS).toHaveLength(6)
    expect(new Set(TYPE_IDS).size).toBe(6)
  })

  it("narrows type ids and rejects anything else", () => {
    expect(isTypeId("reminder")).toBe(true)
    expect(isTypeId("notify")).toBe(false)
  })

  it("resolves docket-core through the workspace", () => {
    expect(isLane("notify")).toBe(true)
  })
})
