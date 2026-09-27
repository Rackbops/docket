import { describe, expect, it } from "vitest"

import { isTimeZone, wallClock, zonedInstant, zoneOffsetMinutes } from "../src/index.js"

const NY = "America/New_York"

describe("zone arithmetic on Intl", () => {
  it("reads the wall clock and the offset in winter and summer", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), NY)).toBe(-300)
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), NY)).toBe(-240)
    const w = wallClock(new Date("2026-03-02T14:05:00Z"), NY)
    expect(w).toEqual({ year: 2026, month: 3, day: 2, hour: 9, minute: 5, weekday: 1 })
  })

  it("finds the instant for a local time on an ordinary day", () => {
    expect(zonedInstant(2026, 3, 2, 9, 0, NY).toISOString()).toBe("2026-03-02T14:00:00.000Z")
    expect(zonedInstant(2026, 7, 4, 9, 0, NY).toISOString()).toBe("2026-07-04T13:00:00.000Z")
  })

  it("resolves a spring-forward gap one hour later", () => {
    // Clocks jump 02:00 -> 03:00 on 2026-03-08; 02:30 does not exist and becomes 03:30 EDT.
    expect(zonedInstant(2026, 3, 8, 2, 30, NY).toISOString()).toBe("2026-03-08T07:30:00.000Z")
    // 09:00 the same day is plain EDT.
    expect(zonedInstant(2026, 3, 8, 9, 0, NY).toISOString()).toBe("2026-03-08T13:00:00.000Z")
  })

  it("resolves an ambiguous fall-back time to its first occurrence", () => {
    // 01:30 happens twice on 2026-11-01; the first is EDT (UTC-4).
    expect(zonedInstant(2026, 11, 1, 1, 30, NY).toISOString()).toBe("2026-11-01T05:30:00.000Z")
  })

  it("knows a zone from a typo", () => {
    expect(isTimeZone(NY)).toBe(true)
    expect(isTimeZone("America/Nowhere")).toBe(false)
  })
})
