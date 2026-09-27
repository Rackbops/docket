import { describe, expect, it } from "vitest"

import { nextDue, type Schedule, scheduleProblems } from "../src/index.js"

const ctx = { zone: "America/New_York", preferredHour: 9 }

describe("nextDue", () => {
  it("fires a once schedule at its instant, and never again", () => {
    const s: Schedule = { kind: "once", at: "2026-03-05T15:00:00.000Z" }
    expect(nextDue(s, new Date("2026-03-01T00:00:00Z"), ctx)?.toISOString()).toBe(s.at)
    expect(nextDue(s, new Date(s.at), ctx)).toBeNull()
  })

  it("keeps a daily reminder at the local hour across the daylight-saving change", () => {
    const s: Schedule = { kind: "calendar", every: 1, unit: "day", start: "2026-03-01" }
    const first = nextDue(s, new Date("2026-03-07T00:00:00Z"), ctx)
    expect(first?.toISOString()).toBe("2026-03-07T14:00:00.000Z") // 09:00 EST
    const second = first ? nextDue(s, first, ctx) : null
    expect(second?.toISOString()).toBe("2026-03-08T13:00:00.000Z") // 09:00 EDT, 23 hours later
  })

  it("uses the schedule's own hour over the owner's preferred hour", () => {
    const s: Schedule = {
      kind: "calendar",
      every: 1,
      unit: "day",
      hour: 18,
      minute: 30,
      start: "2026-03-01",
    }
    expect(nextDue(s, new Date("2026-03-02T00:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-02T23:30:00.000Z",
    )
  })

  it("counts every N days from the start date", () => {
    const s: Schedule = { kind: "calendar", every: 3, unit: "day", start: "2026-03-01" }
    // 2026-03-01, -04, -07, -10 ...
    expect(nextDue(s, new Date("2026-03-02T00:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-04T14:00:00.000Z",
    )
    expect(nextDue(s, new Date("2026-03-04T14:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-07T14:00:00.000Z",
    )
  })

  it("picks the listed weekdays, every N weeks from the start's week", () => {
    // 2026-03-02 is a Monday. Every 2 weeks on Monday and Wednesday.
    const s: Schedule = {
      kind: "calendar",
      every: 2,
      unit: "week",
      weekdays: [1, 3],
      start: "2026-03-02",
    }
    const a = nextDue(s, new Date("2026-03-02T15:00:00Z"), ctx) // after Monday 09:00 -> Wednesday
    expect(a?.toISOString()).toBe("2026-03-04T14:00:00.000Z")
    const b = a ? nextDue(s, a, ctx) : null // next week is skipped; Monday two weeks on (EDT by then)
    expect(b?.toISOString()).toBe("2026-03-16T13:00:00.000Z")
  })

  it("clamps a day-of-month to short months", () => {
    const s: Schedule = {
      kind: "calendar",
      every: 1,
      unit: "month",
      dayOfMonth: 31,
      start: "2026-01-31",
    }
    expect(nextDue(s, new Date("2026-02-01T00:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-02-28T14:00:00.000Z",
    )
    expect(nextDue(s, new Date("2026-03-01T00:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-31T13:00:00.000Z",
    )
  })

  it("never fires before the start date", () => {
    const s: Schedule = { kind: "calendar", every: 1, unit: "day", start: "2026-06-01" }
    expect(nextDue(s, new Date("2026-03-01T00:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-06-01T13:00:00.000Z",
    )
  })
})

describe("scheduleProblems", () => {
  it("accepts the shipped shapes", () => {
    expect(scheduleProblems({ kind: "once", at: "2026-03-05T15:00:00Z" })).toEqual([])
    expect(
      scheduleProblems({
        kind: "calendar",
        every: 1,
        unit: "week",
        weekdays: [0, 6],
        start: "2026-03-01",
      }),
    ).toEqual([])
  })

  it("names what is wrong", () => {
    expect(scheduleProblems({ kind: "once", at: "tomorrow" })).toHaveLength(1)
    const bad: Schedule = {
      kind: "calendar",
      every: 0,
      unit: "day",
      hour: 24,
      weekdays: [],
      start: "03/01/2026",
    }
    expect(scheduleProblems(bad)).toHaveLength(4)
  })
})
