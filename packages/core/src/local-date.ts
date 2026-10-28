/**
 * Calendar dates with no zone, and day arithmetic on them: the helpers `schedule.ts` and
 * `when.ts` share (docket#69). Internal: `index.ts` does not export this module.
 */

export interface LocalDate {
  year: number
  /** 1-12 */
  month: number
  day: number
}

const DAY_MS = 86_400_000

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Whole days between two local dates, counted on a pure calendar (no zone). */
export function dayNumber(d: LocalDate): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / DAY_MS)
}

export function fromDayNumber(n: number): LocalDate {
  const dt = new Date(n * DAY_MS)
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() }
}

/** `d` moved by `days` whole days. */
export function addDays(d: LocalDate, days: number): LocalDate {
  return fromDayNumber(dayNumber(d) + days)
}
