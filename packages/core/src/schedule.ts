import { wallClock, zonedInstant } from "./zoned.js"

/**
 * Schedule kinds (plan section 5.3). `once` and `calendar` shipped with the reminder slice
 * (city-hall#7); `poll` and `period` with the renewal and price types (city-hall#11). Catch-up
 * is per kind: a missed `once` fires late; a missed calendar or period occurrence fires once
 * late, then the next is computed from now; a missed poll is simply the next poll.
 */
export const SCHEDULE_KINDS = ["once", "calendar", "poll", "period"] as const

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

/**
 * Every N minutes or hours from `start`, on a fixed grid, until `until` or until the type ends
 * the task (a price tracker stopped, a watcher that found its item). The grid, not the last
 * run, anchors the next due instant, so a poll that ran late does not drift.
 */
export interface PollSchedule {
  kind: "poll"
  /** >= 1; the interval is at least `MIN_POLL_MINUTES`. */
  every: number
  unit: "minute" | "hour"
  /** ISO-8601 instant the grid counts from; the host sets it to the creation instant. */
  start: string
  /** ISO-8601 instant after which the schedule is never due again. */
  until?: string
}

/**
 * Period from an anchor date (plan 5.3, category 6): every N days, weeks, months or years
 * from `anchor`, firing `leadDays` before each period date at a local time in the owner's zone.
 * A renewal on the 31st rolls to the 28th or 29th in February and back to the 31st after.
 * The periods count from the anchor, never from the last completion: a domain that is renewed
 * late still expires a year after it expired, not a year after it was paid.
 */
export interface PeriodSchedule {
  kind: "period"
  /** >= 1 */
  every: number
  unit: "day" | "week" | "month" | "year"
  /** The first period date, `YYYY-MM-DD`: the renewal or expiry date the periods count from. */
  anchor: string
  /** Fire this many days before each period date; default 0 (on the day). */
  leadDays?: number
  /** Local hour; default the owner's preferred hour. */
  hour?: number
  /** Local minute; default 0. */
  minute?: number
}

export type Schedule = OnceSchedule | CalendarSchedule | PollSchedule | PeriodSchedule

export interface ScheduleContext {
  /** IANA zone the local times are read in. */
  zone: string
  /** The owner's preferred hour, used when a schedule names none. */
  preferredHour: number
}

/** The shortest poll interval: the notify lane ticks once a minute, and sites are not ours. */
export const MIN_POLL_MINUTES = 5

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
/** How far ahead `nextDue` searches before giving up on a calendar schedule. */
const HORIZON_DAYS = 366 * 3
/** How many periods ahead `nextDue` searches before giving up on a period schedule. */
const HORIZON_PERIODS = 100_000

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

function formatLocalDate(d: LocalDate): string {
  const mm = String(d.month).padStart(2, "0")
  const dd = String(d.day).padStart(2, "0")
  return `${d.year}-${mm}-${dd}`
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

/** `anchor` moved by `months` whole months, the day clamped to the target month's length. */
function addMonths(anchor: LocalDate, months: number): LocalDate {
  const index = anchor.year * 12 + (anchor.month - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  return { year, month, day: Math.min(anchor.day, daysInMonth(year, month)) }
}

/** The `n`th period date of a period schedule, `n` = 0 being the anchor itself. */
function periodDateAt(schedule: PeriodSchedule, n: number): LocalDate | null {
  const anchor = parseLocalDate(schedule.anchor)
  if (!anchor) return null
  const steps = n * schedule.every
  switch (schedule.unit) {
    case "day":
      return fromDayNumber(dayNumber(anchor) + steps)
    case "week":
      return fromDayNumber(dayNumber(anchor) + steps * 7)
    case "month":
      return addMonths(anchor, steps)
    case "year":
      return addMonths(anchor, steps * 12)
  }
}

function isInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
}

function checkLocalTime(
  prefix: string,
  schedule: { hour?: number; minute?: number },
  problems: string[],
): void {
  if (
    schedule.hour !== undefined &&
    (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23)
  ) {
    problems.push(`${prefix}.hour must be 0 to 23`)
  }
  if (
    schedule.minute !== undefined &&
    (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59)
  ) {
    problems.push(`${prefix}.minute must be 0 to 59`)
  }
}

function calendarProblems(schedule: CalendarSchedule): string[] {
  const problems: string[] = []
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
  checkLocalTime("calendar", schedule, problems)
  return problems
}

function pollIntervalMs(schedule: PollSchedule): number {
  return schedule.every * (schedule.unit === "hour" ? 60 : 1) * MINUTE_MS
}

function pollProblems(schedule: PollSchedule): string[] {
  const problems: string[] = []
  if (!Number.isInteger(schedule.every) || schedule.every < 1) {
    problems.push("poll.every must be a whole number >= 1")
  }
  if (!["minute", "hour"].includes(schedule.unit)) {
    problems.push("poll.unit must be minute or hour")
  } else if (problems.length === 0 && pollIntervalMs(schedule) < MIN_POLL_MINUTES * MINUTE_MS) {
    problems.push(`poll interval must be at least ${MIN_POLL_MINUTES} minutes`)
  }
  if (!isInstant(schedule.start)) problems.push("poll.start is not an ISO-8601 instant")
  if (schedule.until !== undefined) {
    if (!isInstant(schedule.until)) problems.push("poll.until is not an ISO-8601 instant")
    else if (
      isInstant(schedule.start) &&
      Date.parse(schedule.until) <= Date.parse(schedule.start)
    ) {
      problems.push("poll.until must be after poll.start")
    }
  }
  return problems
}

function periodProblems(schedule: PeriodSchedule): string[] {
  const problems: string[] = []
  if (!Number.isInteger(schedule.every) || schedule.every < 1) {
    problems.push("period.every must be a whole number >= 1")
  }
  if (!["day", "week", "month", "year"].includes(schedule.unit)) {
    problems.push("period.unit must be day, week, month or year")
  }
  if (!parseLocalDate(schedule.anchor)) problems.push("period.anchor must be a YYYY-MM-DD date")
  if (
    schedule.leadDays !== undefined &&
    (!Number.isInteger(schedule.leadDays) || schedule.leadDays < 0)
  ) {
    problems.push("period.leadDays must be a whole number >= 0")
  }
  checkLocalTime("period", schedule, problems)
  return problems
}

/** Problems with a schedule, in words. Empty means valid. */
export function scheduleProblems(schedule: Schedule): string[] {
  switch (schedule.kind) {
    case "once":
      return isInstant(schedule.at) ? [] : ["once.at is not an ISO-8601 instant"]
    case "calendar":
      return calendarProblems(schedule)
    case "poll":
      return pollProblems(schedule)
    case "period":
      return periodProblems(schedule)
  }
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

function nextCalendarDue(
  schedule: CalendarSchedule,
  after: Date,
  ctx: ScheduleContext,
): Date | null {
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

function nextPollDue(schedule: PollSchedule, after: Date): Date | null {
  const start = Date.parse(schedule.start)
  if (Number.isNaN(start)) return null
  const interval = pollIntervalMs(schedule)
  const elapsed = after.getTime() - start
  const steps = elapsed < 0 ? 0 : Math.floor(elapsed / interval) + 1
  const due = start + steps * interval
  if (schedule.until !== undefined && due > Date.parse(schedule.until)) return null
  return new Date(due)
}

function nextPeriodDue(schedule: PeriodSchedule, after: Date, ctx: ScheduleContext): Date | null {
  const hour = schedule.hour ?? ctx.preferredHour
  const minute = schedule.minute ?? 0
  const lead = schedule.leadDays ?? 0
  for (let n = 0; n < HORIZON_PERIODS; n++) {
    const date = periodDateAt(schedule, n)
    if (!date) return null
    const fire = fromDayNumber(dayNumber(date) - lead)
    const instant = zonedInstant(fire.year, fire.month, fire.day, hour, minute, ctx.zone)
    if (instant.getTime() > after.getTime()) return instant
  }
  return null
}

/**
 * The first instant strictly after `after` at which `schedule` is due, or null when it never is
 * again. Calendar and period arithmetic is local to `ctx.zone`, so a daily 09:00 stays 09:00
 * across a daylight-saving change; a poll grid is plain elapsed time.
 */
export function nextDue(schedule: Schedule, after: Date, ctx: ScheduleContext): Date | null {
  switch (schedule.kind) {
    case "once": {
      const at = new Date(schedule.at)
      return at.getTime() > after.getTime() ? at : null
    }
    case "calendar":
      return nextCalendarDue(schedule, after, ctx)
    case "poll":
      return nextPollDue(schedule, after)
    case "period":
      return nextPeriodDue(schedule, after, ctx)
  }
}

/**
 * The period date (`YYYY-MM-DD`) that an occurrence due at `due` announces: the local day of the
 * due instant plus the schedule's lead. A renewal type says "renews on <this>", not "fires on".
 */
export function periodDate(schedule: PeriodSchedule, due: Date, zone: string): string {
  const local = wallClock(due, zone)
  const fire = { year: local.year, month: local.month, day: local.day }
  return formatLocalDate(fromDayNumber(dayNumber(fire) + (schedule.leadDays ?? 0)))
}

/** Whole days from the local day of `now` to a `YYYY-MM-DD` date; negative when it has passed. */
export function daysUntil(date: string, now: Date, zone: string): number | null {
  const target = parseLocalDate(date)
  if (!target) return null
  const local = wallClock(now, zone)
  return dayNumber(target) - dayNumber({ year: local.year, month: local.month, day: local.day })
}
