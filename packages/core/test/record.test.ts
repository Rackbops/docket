import { describe, expect, it } from "vitest"

import { hasFired, type Occurrence, parseRunRecord } from "../src/index.js"
import { T0 } from "./helpers.js"

const good = {
  outcome: { notify: { text: "hi", actions: ["done"] }, summary: "s", series: [{ value: 1 }] },
  costUsd: null,
  firedAt: T0,
  appliedAt: null,
  resumes: 0,
}

describe("parseRunRecord", () => {
  it("reads back a record the dispatcher writes", () => {
    expect(parseRunRecord(good)).toEqual(good)
  })

  it.each([
    ["no record", null],
    ["an array", []],
    ["a message carrying a reply ref", { ...good, outcome: { notify: { text: "x", ref: {} } } }],
    ["a snoozeUntil", { ...good, outcome: { snoozeUntil: T0 } }],
    ["an unknown action", { ...good, outcome: { notify: { text: "x", actions: ["buy"] } } }],
    ["a series point without a number", { ...good, outcome: { series: [{ value: "1" }] } }],
    ["a finding without text", { ...good, outcome: { findings: [{ tags: [] }] } }],
    ["a cost that is not a number", { ...good, costUsd: "1" }],
    ["no firedAt", { ...good, firedAt: undefined }],
    ["a fractional resume count", { ...good, resumes: 0.5 }],
  ])("refuses %s", (_what, value) => {
    expect(parseRunRecord(value)).toBeNull()
  })

  it("counts any stored record as fired, well-formed or not", () => {
    expect(hasFired({ record: null } as Occurrence)).toBe(false)
    expect(hasFired({ record: { junk: 1 } } as unknown as Occurrence)).toBe(true)
  })
})
