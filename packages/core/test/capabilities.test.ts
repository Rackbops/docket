import { describe, expect, it } from "vitest"

import {
  CAPABILITIES,
  CAPABILITY_TIER,
  defineTaskType,
  isCapability,
  type TaskType,
  unknownCapabilities,
} from "../src/index.js"

const notify: TaskType<unknown> = {
  id: "t",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["once"],
  run: async () => ({}),
}

describe("the grantable set", () => {
  it("holds tier 0 and tier 1 members only", () => {
    expect(CAPABILITIES).toEqual(["notify", "graph:write", "discord:post", "github:issue"])
    for (const c of CAPABILITIES) expect([0, 1]).toContain(CAPABILITY_TIER[c])
    expect(isCapability("purchase")).toBe(false)
    expect(unknownCapabilities(["notify", "email:send", "bid"])).toEqual(["email:send", "bid"])
  })
})

describe("defineTaskType", () => {
  it("returns a frozen copy of a clean declaration", () => {
    const t = defineTaskType(notify)
    expect(Object.isFrozen(t)).toBe(true)
    expect(t.id).toBe("t")
  })

  it("refuses a type that declares a capability outside the grantable set", () => {
    const bad = { ...notify, capabilities: ["notify", "purchase"] } as unknown as TaskType<unknown>
    expect(() => defineTaskType(bad)).toThrow(/ungrantable capabilities: purchase/)
  })

  it("refuses the wrong methods for a lane, and unknown schedule kinds", () => {
    expect(() => defineTaskType({ ...notify, run: undefined })).toThrow(/needs run/)
    expect(() => defineTaskType({ ...notify, lane: "execute" })).toThrow(/prepare and finish/)
    const kinds = { ...notify, schedule: ["hourly"] } as unknown as TaskType<unknown>
    expect(() => defineTaskType(kinds)).toThrow(/unknown schedule kinds: hourly/)
  })
})
