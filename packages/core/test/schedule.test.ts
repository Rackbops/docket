import { describe, expect, it } from "vitest"

import {
  daysUntil,
  MIN_POLL_MINUTES,
  nextDue,
  type PeriodSchedule,
  periodDate,
  type Schedule,
  scheduleProblems,
  zonedInstant,
} from "../src/index.js"

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

describe("nextDue: poll", () => {
  const s: Schedule = { kind: "poll", every: 15, unit: "minute", start: "2026-03-02T12:00:00Z" }

  it("walks a fixed grid from the start, and does not drift after a late run", () => {
    expect(nextDue(s, new Date("2026-03-02T12:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-02T12:15:00.000Z",
    )
    // The 12:15 poll ran at 12:22; the next is still 12:30, not 12:37.
    expect(nextDue(s, new Date("2026-03-02T12:22:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-02T12:30:00.000Z",
    )
    // Down for two hours: a missed poll is simply the next poll.
    expect(nextDue(s, new Date("2026-03-02T14:31:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-02T14:45:00.000Z",
    )
  })

  it("fires at the start when asked from before it", () => {
    expect(nextDue(s, new Date("2026-03-01T00:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-02T12:00:00.000Z",
    )
  })

  it("stops at until", () => {
    const bounded: Schedule = { ...s, until: "2026-03-02T12:30:00Z" }
    expect(nextDue(bounded, new Date("2026-03-02T12:16:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-02T12:30:00.000Z",
    )
    expect(nextDue(bounded, new Date("2026-03-02T12:30:00Z"), ctx)).toBeNull()
  })

  it("counts hours too", () => {
    const hourly: Schedule = { kind: "poll", every: 6, unit: "hour", start: "2026-03-02T12:00:00Z" }
    expect(nextDue(hourly, new Date("2026-03-02T12:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-02T18:00:00.000Z",
    )
  })
})

describe("nextDue: period", () => {
  it("gives an old anchor the due dates a walk from its first period gives (docket#62)", () => {
    // The reference walks every period from the anchor, as nextDue did before it skipped ahead;
    // only dates near the sweep are turned into instants.
    const from = Date.parse("2026-02-01T00:00:00Z")
    const to = from + 800 * 86_400_000
    const fires = (s: PeriodSchedule): number[] => {
      const [y, m, d] = s.anchor.split("-").map(Number) as [number, number, number]
      const out: number[] = []
      for (let n = 0; ; n++) {
        const k = n * s.every
        let date: Date
        if (s.unit === "day" || s.unit === "week") {
          date = new Date(Date.UTC(y, m - 1, d + k * (s.unit === "week" ? 7 : 1)))
        } else {
          const months = k * (s.unit === "year" ? 12 : 1)
          const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate()
          date = new Date(Date.UTC(y, m - 1 + months, Math.min(d, last)))
        }
        const fire = date.getTime() - (s.leadDays ?? 0) * 86_400_000
        if (fire > to + 400 * 86_400_000) return out
        if (fire < from - 2 * 86_400_000) continue
        const f = new Date(fire)
        out.push(
          zonedInstant(
            f.getUTCFullYear(),
            f.getUTCMonth() + 1,
            f.getUTCDate(),
            s.hour ?? ctx.preferredHour,
            s.minute ?? 0,
            ctx.zone,
          ).getTime(),
        )
      }
    }
    const old: PeriodSchedule[] = [
      { kind: "period", every: 1, unit: "day", anchor: "1900-01-01" },
      { kind: "period", every: 2, unit: "week", anchor: "1900-01-01", hour: 18 },
      { kind: "period", every: 1, unit: "month", anchor: "1900-01-31", leadDays: 3 },
      { kind: "period", every: 3, unit: "month", anchor: "1901-02-28" },
      { kind: "period", every: 1, unit: "year", anchor: "1904-02-29", leadDays: 14 },
    ]
    for (const s of old) {
      const all = fires(s)
      for (let t = from; t < to; t += 37 * 3_600_000) {
        const want = all.find((f) => f > t)
        const got = nextDue(s, new Date(t), ctx)?.getTime()
        expect(got, `${s.unit} ${s.anchor} after ${new Date(t).toISOString()}`).toBe(want)
      }
    }
  })

  it("rolls a yearly renewal from its anchor, asking at lead time in the owner's zone", () => {
    const s: PeriodSchedule = {
      kind: "period",
      every: 1,
      unit: "year",
      anchor: "2026-10-01",
      leadDays: 7,
    }
    const first = nextDue(s, new Date("2026-03-02T12:00:00Z"), ctx)
    expect(first?.toISOString()).toBe("2026-09-24T13:00:00.000Z") // 09:00 EDT, 7 days before
    expect(first && periodDate(s, first, ctx.zone)).toBe("2026-10-01")
    expect(first && daysUntil("2026-10-01", first, ctx.zone)).toBe(7)
    const second = first ? nextDue(s, first, ctx) : null
    expect(second?.toISOString()).toBe("2027-09-24T13:00:00.000Z")
  })

  it("clamps a monthly renewal on the 31st to short months and comes back", () => {
    const s: PeriodSchedule = { kind: "period", every: 1, unit: "month", anchor: "2026-01-31" }
    expect(nextDue(s, new Date("2026-02-01T00:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-02-28T14:00:00.000Z",
    )
    expect(nextDue(s, new Date("2026-03-01T00:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-31T13:00:00.000Z",
    )
  })

  it("counts every N weeks and days from the anchor, before the anchor too", () => {
    const fortnightly: PeriodSchedule = {
      kind: "period",
      every: 2,
      unit: "week",
      anchor: "2026-03-02",
      hour: 18,
    }
    expect(nextDue(fortnightly, new Date("2026-03-02T23:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-03-16T22:00:00.000Z",
    )
    const early: PeriodSchedule = {
      kind: "period",
      every: 90,
      unit: "day",
      anchor: "2026-06-01",
      leadDays: 3,
    }
    expect(nextDue(early, new Date("2026-03-01T00:00:00Z"), ctx)?.toISOString()).toBe(
      "2026-05-29T13:00:00.000Z",
    )
  })
})

describe("scheduleProblems", () => {
  it("accepts the shipped shapes", () => {
    expect(scheduleProblems({ kind: "once", at: "2026-03-05T15:00:00Z" })).toEqual([])
    expect(
      scheduleProblems({ kind: "poll", every: 6, unit: "hour", start: "2026-03-02T12:00:00Z" }),
    ).toEqual([])
    expect(
      scheduleProblems({
        kind: "period",
        every: 1,
        unit: "year",
        anchor: "2026-10-01",
        leadDays: 7,
      }),
    ).toEqual([])
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
    // A step longer than nextDue's search horizon would be accepted and then never fire.
    expect(
      scheduleProblems({ kind: "calendar", every: 48, unit: "month", start: "2026-01-15" }),
    ).toEqual(["calendar.every must be at most 36 for unit month"])
    expect(
      scheduleProblems({ kind: "calendar", every: 200, unit: "week", start: "2026-01-15" }),
    ).toEqual(["calendar.every must be at most 156 for unit week"])
    expect(
      scheduleProblems({ kind: "calendar", every: 1098, unit: "day", start: "2026-01-15" }),
    ).toEqual(["calendar.every must be at most 1097 for unit day"])
    // The largest accepted step still fires, from just after each run, across the widest gaps:
    // a clamped Feb 28 to a leap Feb 29, the far ends of a week, a 1097-day step.
    const cases: [Schedule, string][] = [
      [
        { kind: "calendar", every: 36, unit: "month", start: "2029-02-28", dayOfMonth: 31 },
        "month",
      ],
      [{ kind: "calendar", every: 36, unit: "month", start: "2026-01-31" }, "month"],
      [
        { kind: "calendar", every: 156, unit: "week", weekdays: [0, 6], start: "2026-01-04" },
        "week",
      ],
      [{ kind: "calendar", every: 156, unit: "week", weekdays: [6], start: "2026-01-04" }, "week"],
      [{ kind: "calendar", every: 1097, unit: "day", start: "2026-01-15" }, "day"],
    ]
    const zones = ["America/New_York", "Pacific/Kiritimati", "Pacific/Pago_Pago"]
    for (const [s] of cases) {
      expect(scheduleProblems(s)).toEqual([])
      for (const zone of zones) {
        for (const hour of [0, 23]) {
          let at = new Date("2025-12-01T00:00:00Z")
          for (let i = 0; i < 3; i++) {
            const next = nextDue(s, at, { zone, preferredHour: hour })
            expect(next, `${JSON.stringify(s)} ${zone} ${hour} run ${i}`).not.toBeNull()
            at = next ?? at
          }
        }
      }
    }
    expect(
      scheduleProblems({ kind: "poll", every: 1, unit: "minute", start: "2026-03-02T12:00:00Z" }),
    ).toEqual([`poll interval must be at least ${MIN_POLL_MINUTES} minutes`])
    expect(
      scheduleProblems({
        kind: "poll",
        every: 1,
        unit: "hour",
        start: "2026-03-02T12:00:00Z",
        until: "2026-03-02T11:00:00Z",
      }),
    ).toEqual(["poll.until must be after poll.start"])
    expect(
      scheduleProblems({
        kind: "period",
        every: 1,
        unit: "fortnight" as "week",
        anchor: "2026-02-30",
        leadDays: -1,
      }),
    ).toHaveLength(3)
  })
})
