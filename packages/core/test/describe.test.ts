import { describe, expect, it } from "vitest"

import { describeSchedule, formatInstant } from "../src/index.js"

const owner = { timeZone: "America/New_York", preferredHour: 9 }

describe("formatInstant", () => {
  it("shows the wall clock in the zone, with the year only when it differs", () => {
    expect(formatInstant("2026-09-29T13:00:00.000Z", "America/New_York")).toBe("Tue Sep 29, 9:00")
    expect(formatInstant("2026-09-29T13:00:00.000Z", "America/Los_Angeles")).toBe(
      "Tue Sep 29, 6:00",
    )
    const now = new Date("2026-12-30T00:00:00.000Z")
    expect(formatInstant("2027-01-04T15:30:00.000Z", "UTC", now)).toBe("Mon Jan 4 2027, 15:30")
  })
})

describe("describeSchedule", () => {
  it("says calendar cadences in words, defaulting to the preferred hour", () => {
    const start = "2026-03-02" // a Monday
    expect(describeSchedule({ kind: "calendar", every: 1, unit: "day", start }, owner)).toBe(
      "daily at 9:00",
    )
    expect(
      describeSchedule(
        { kind: "calendar", every: 2, unit: "week", weekdays: [4, 1], hour: 18, minute: 5, start },
        owner,
      ),
    ).toBe("every 2 weeks on Mon and Thu at 18:05")
    expect(describeSchedule({ kind: "calendar", every: 1, unit: "week", start }, owner)).toBe(
      "weekly on Mon at 9:00",
    )
    expect(
      describeSchedule({ kind: "calendar", every: 1, unit: "month", dayOfMonth: 22, start }, owner),
    ).toBe("monthly on the 22nd at 9:00")
    expect(describeSchedule({ kind: "calendar", every: 3, unit: "month", start }, owner)).toBe(
      "every 3 months on the 2nd at 9:00",
    )
  })

  it("names the owner's zone when the viewer is elsewhere", () => {
    const s = { kind: "calendar" as const, every: 1, unit: "day" as const, start: "2026-03-02" }
    expect(describeSchedule(s, owner, "Europe/London")).toBe(
      "daily at 9:00 (America/New_York time)",
    )
  })

  it("shows a one-off in the viewer's zone, and polls and periods plainly", () => {
    expect(
      describeSchedule({ kind: "once", at: "2026-09-29T18:00:00.000Z" }, owner, "Europe/London"),
    ).toBe("once, Tue Sep 29, 19:00")
    expect(describeSchedule({ kind: "poll", every: 1, unit: "hour", start: "x" }, owner)).toBe(
      "every hour",
    )
    expect(describeSchedule({ kind: "poll", every: 30, unit: "minute", start: "x" }, owner)).toBe(
      "every 30 minutes",
    )
    expect(
      describeSchedule(
        { kind: "period", every: 1, unit: "year", anchor: "2026-10-01", leadDays: 14 },
        owner,
      ),
    ).toBe("every year from 2026-10-01, 14 days ahead")
    expect(
      describeSchedule(
        { kind: "period", every: 1, unit: "year", anchor: "2026-10-01", leadDays: 1 },
        owner,
      ),
    ).toBe("every year from 2026-10-01, 1 day ahead")
    const nextYear = { kind: "once", at: "2027-01-05T14:00:00.000Z" } as const
    expect(
      describeSchedule(nextYear, owner, owner.timeZone, new Date("2026-09-29T12:00:00Z")),
    ).toBe("once, Tue Jan 5 2027, 9:00")
  })
})
