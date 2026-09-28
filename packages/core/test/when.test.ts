import { describe, expect, it } from "vitest"

import { parseWhen } from "../src/index.js"

const zone = "America/New_York"
// Monday 2 March 2026, 07:00 in New York (12:00Z; EST, UTC-5).
const now = new Date("2026-03-02T12:00:00.000Z")
const opts = { zone, defaultHour: 9 }

function at(text: string, when = now): string {
  const r = parseWhen(text, when, opts)
  if (!r.ok) throw new Error(r.error)
  return r.at.toISOString()
}

describe("parseWhen", () => {
  it("reads relative offsets", () => {
    expect(at("in 20 minutes")).toBe("2026-03-02T12:20:00.000Z")
    expect(at("in 2h")).toBe("2026-03-02T14:00:00.000Z")
    expect(at("in an hour")).toBe("2026-03-02T13:00:00.000Z")
    expect(at("in 3 days")).toBe("2026-03-05T12:00:00.000Z")
    expect(at("In  1 Week")).toBe("2026-03-09T12:00:00.000Z")
  })

  it("reads a time today, or tomorrow once it has passed", () => {
    expect(at("9am")).toBe("2026-03-02T14:00:00.000Z")
    expect(at("17:30")).toBe("2026-03-02T22:30:00.000Z")
    expect(at("at noon")).toBe("2026-03-02T17:00:00.000Z")
    expect(at("6am")).toBe("2026-03-03T11:00:00.000Z")
    expect(at("midnight")).toBe("2026-03-03T05:00:00.000Z")
    expect(at("12am")).toBe("2026-03-03T05:00:00.000Z")
  })

  it("reads a day, at the default hour or the time given, in either order", () => {
    expect(at("tomorrow")).toBe("2026-03-03T14:00:00.000Z")
    expect(at("tomorrow 7:15pm")).toBe("2026-03-04T00:15:00.000Z")
    expect(at("9am tomorrow")).toBe("2026-03-03T14:00:00.000Z")
    expect(at("fri at 17:30")).toBe("2026-03-06T22:30:00.000Z")
    expect(at("on friday")).toBe("2026-03-06T14:00:00.000Z")
    expect(at("today 5pm")).toBe("2026-03-02T22:00:00.000Z")
  })

  it("takes this weekday while its time is ahead, else next week's", () => {
    expect(at("monday 8am")).toBe("2026-03-02T13:00:00.000Z")
    // Next Monday is after the spring-forward (8 March): 6:00 EDT is 10:00Z.
    expect(at("monday 6am")).toBe("2026-03-09T10:00:00.000Z")
  })

  it("reads dates, rolling a past month/day into next year", () => {
    expect(at("2026-10-01 9:00")).toBe("2026-10-01T13:00:00.000Z")
    expect(at("on 10/1 at noon")).toBe("2026-10-01T16:00:00.000Z")
    expect(at("1/15")).toBe("2027-01-15T14:00:00.000Z")
    expect(at("2026-03-02T20:00:00Z")).toBe("2026-03-02T20:00:00.000Z")
  })

  it("stays on the wall clock across a daylight-saving change", () => {
    // 8 March 2026 is spring-forward in New York; 9:00 after it is 13:00Z, not 14:00Z.
    expect(at("2026-03-09 9am")).toBe("2026-03-09T13:00:00.000Z")
    expect(at("in 7 days")).toBe("2026-03-09T12:00:00.000Z")
  })

  it("explains what it could not read, and refuses the past", () => {
    for (const bad of [
      "",
      "whenever",
      "25:00",
      "13pm",
      "in 0 days",
      "2026-02-30",
      "13/1",
      "blursday 9am",
    ]) {
      const r = parseWhen(bad, now, opts)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/Try "in 2 hours"/)
    }
    const past = parseWhen("today 6am", now, opts)
    expect(past.ok ? "" : past.error).toMatch(/already passed/)
    expect(parseWhen("2026-01-01 9:00", now, opts).ok).toBe(false)
    expect(parseWhen("2026-03-01T00:00:00Z", now, opts).ok).toBe(false)
  })

  it("refuses what would land somewhere surprising", () => {
    const error = (text: string, o = opts) => {
      const r = parseWhen(text, now, o)
      return r.ok ? r.at.toISOString() : r.error
    }
    // An impossible ISO date is an error, not the next month.
    expect(error("2027-02-30T13:00:00Z")).toMatch(/2027-02-30 is not a date/)
    expect(error("2026-11-31T09:00:00-05:00")).toMatch(/is not a date/)
    // Offsets have a ceiling rather than an Invalid Date or a year 21039.
    expect(error("in 20000000 weeks")).toMatch(/more than 5 years away/)
    expect(error("in 9999999999 minutes")).toMatch(/more than 5 years away/)
    // Today's M/D once its hour has passed says so, like "today" and the ISO form.
    expect(error("3/2 6am")).toMatch(/already passed/)
    expect(at("3/2 9am")).toBe("2026-03-02T14:00:00.000Z")
    // A date that has passed this year is next year's; 2/29 is the next leap year's.
    expect(at("3/1")).toBe("2027-03-01T14:00:00.000Z")
    expect(at("2/29")).toBe("2028-02-29T14:00:00.000Z")
    // An unknown zone is an error to show, not a throw.
    expect(error("9am", { zone: "Mars/Base", defaultHour: 9 })).toMatch(/time zone Mars\/Base/)
  })
})
