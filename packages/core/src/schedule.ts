import { wallClock, zonedInstant } from "./zoned.js"

/**
 * Schedule kinds (plan section 5.3). `once` and `calendar` ship with the reminder slice
 * (city-hall#7); `poll` and `period` arrive with the renewal and price types (E6) and are not
 * named here until they do.
 */
export const SCHEDULE_KINDS = ["once", "calendar"] as const

export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

export function isScheduleKind(value: string): value is ScheduleKind {
  return (SCHEDULE_KINDS as readonly string[]).includes(value)
}

/** Fires once, at an instant. */
export interface OnceSchedule {
  kind: "once"
  /** ISO-8601 instant. */
  at: string
}

/**
 * Every N days, weeks or months, at a local time in the owner's zone. `start` anchors the
 * count ("every 2 weeks" needs a first week) and is a local calendar date, `YYYY-MM-DD`.
 */
export interface CalendarSchedule {
  kind: "calendar"
  /** >= 1 */
  every: number
  unit: "day" | "week" | "month"
  /** For `week`: which weekdays (0 = Sunday .. 6 = Saturday); default the start date's. */
  weekdays?: number[]
  /** For `month`: 1-31, clamped to the month's length; default the start date's day. */
  dayOfMonth?: number
  /** Local hour; default the owner's preferred hour. */
  hour?: number
  /** Local minute; default 0. */
  minute?: number
  start: string
}

export type Schedule = OnceSchedule | CalendarSchedule

export interface ScheduleContext {
  /** IANA zone the local times are read in. */
  zone: string
  /** The owner's preferred hour, used when a calendar schedule names none. */
  preferredHour: number
}

const DAY_MS = 86_400_000
/** How far ahead `nextDue` searches before giving up on a calendar schedule. */
const HORIZON_DAYS = 366 * 3

interface LocalDate {
  year: number
  month: number
  day: number
}

function parseLocalDate(value: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Whole days between two local dates, counted on a pure calendar (no zone). */
function dayNumber(d: LocalDate): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / DAY_MS)
}

function fromDayNumber(n: number): LocalDate {
  const dt = new Date(n * DAY_MS)
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() }
}

function weekdayOf(d: LocalDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()
}

/** Problems with a schedule, in words. Empty means valid. */
export function scheduleProblems(schedule: Schedule): string[] {
  const problems: string[] = []
  if (schedule.kind === "once") {
    if (Number.isNaN(Date.parse(schedule.at))) problems.push("once.at is not an ISO-8601 instant")
    return problems
  }
  if (!Number.isInteger(schedule.every) || schedule.every < 1) {
    problems.push("calendar.every must be a whole number >= 1")
  }
  if (!["day", "week", "month"].includes(schedule.unit)) problems.push("calendar.unit is unknown")
  if (!parseLocalDate(schedule.start)) problems.push("calendar.start must be a YYYY-MM-DD date")
  if (schedule.weekdays !== undefined) {
    if (schedule.weekdays.length === 0) problems.push("calendar.weekdays must not be empty")
    if (schedule.weekdays.some((w) => !Number.isInteger(w) || w < 0 || w > 6)) {
      problems.push("calendar.weekdays must be 0 (Sunday) to 6 (Saturday)")
    }
  }
  if (schedule.dayOfMonth !== undefined) {
    if (
      !Number.isInteger(schedule.dayOfMonth) ||
      schedule.dayOfMonth < 1 ||
      schedule.dayOfMonth > 31
    ) {
      problems.push("calendar.dayOfMonth must be 1 to 31")
    }
  }
  if (
    schedule.hour !== undefined &&
    (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23)
  ) {
    problems.push("calendar.hour must be 0 to 23")
  }
  if (
    schedule.minute !== undefined &&
    (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59)
  ) {
    problems.push("calendar.minute must be 0 to 59")
  }
  return problems
}

function matchesDay(schedule: CalendarSchedule, start: LocalDate, day: LocalDate): boolean {
  const gap = dayNumber(day) - dayNumber(start)
  if (gap < 0) return false
  switch (schedule.unit) {
    case "day":
      return gap % schedule.every === 0
    case "week": {
      const weekdays = schedule.weekdays ?? [weekdayOf(start)]
      const startOfWeek = dayNumber(start) - weekdayOf(start)
      const weeks = Math.floor((dayNumber(day) - startOfWeek) / 7)
      return weeks % schedule.every === 0 && weekdays.includes(weekdayOf(day))
    }
    case "month": {
      const months = (day.year - start.year) * 12 + (day.month - start.month)
      if (months < 0 || months % schedule.every !== 0) return false
      const wanted = Math.min(schedule.dayOfMonth ?? start.day, daysInMonth(day.year, day.month))
      return day.day === wanted
    }
  }
}

/**
 * The first instant strictly after `after` at which `schedule` is due, or null when it never is
 * again. Calendar arithmetic is local to `ctx.zone`, so a daily 09:00 stays 09:00 across a
 * daylight-saving change.
 */
export function nextDue(schedule: Schedule, after: Date, ctx: ScheduleContext): Date | null {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at)
    return at.getTime() > after.getTime() ? at : null
  }
  const start = parseLocalDate(schedule.start)
  if (!start) return null
  const hour = schedule.hour ?? ctx.preferredHour
  const minute = schedule.minute ?? 0
  const local = wallClock(after, ctx.zone)
  const firstDay = Math.max(
    dayNumber({ year: local.year, month: local.month, day: local.day }),
    dayNumber(start),
  )
  for (let n = firstDay; n < firstDay + HORIZON_DAYS; n++) {
    const day = fromDayNumber(n)
    if (!matchesDay(schedule, start, day)) continue
    const instant = zonedInstant(day.year, day.month, day.day, hour, minute, ctx.zone)
    if (instant.getTime() > after.getTime()) return instant
  }
  return null
}
