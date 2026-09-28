import type { Schedule } from "./schedule.js"
import { wallClock } from "./zoned.js"

/**
 * Schedules and instants in words (plan section 5.5): the consent DM states the cadence, the
 * task list shows what is next. An instant reads in the viewer's own zone. A recurring
 * wall-clock time stays the owner's and names that zone when the viewer's differs: the owner's
 * 9:00 is not one fixed hour elsewhere once the two zones change clocks on different dates.
 * English only, and short enough for a Discord line.
 */

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function clockTime(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`
}

/** `Tue Sep 29, 9:00` in `zone`; the year is added when it differs from `now`'s. */
export function formatInstant(instant: Date | string, zone: string, now?: Date): string {
  const w = wallClock(new Date(instant), zone)
  const year = now && wallClock(now, zone).year !== w.year ? ` ${w.year}` : ""
  return `${WD[w.weekday]} ${MON[w.month - 1]} ${w.day}${year}, ${clockTime(w.hour, w.minute)}`
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`
}

function every(n: number, unit: string, single: string): string {
  return n === 1 ? single : `every ${n} ${unit}s`
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/** The weekday (0-6) and day of month of a `YYYY-MM-DD` date. */
function dateParts(date: string): { weekday: number; day: number } {
  const d = new Date(`${date}T00:00:00Z`)
  return { weekday: d.getUTCDay(), day: d.getUTCDate() }
}

export interface ScheduleOwner {
  /** The owner's zone: calendar and period times are wall-clock times there. */
  timeZone: string
  /** The hour a schedule without one fires at. */
  preferredHour: number
}

/**
 * The cadence in words: `daily at 9:00`, `every 2 weeks on Mon and Thu at 9:00`, `once, Tue
 * Sep 29, 14:00`. A `once` instant is shown in `viewerZone`, with its year when it differs from
 * `now`'s; recurring wall-clock times are the owner's, and say so when the viewer's zone is
 * another.
 */
export function describeSchedule(
  schedule: Schedule,
  owner: ScheduleOwner,
  viewerZone: string = owner.timeZone,
  now?: Date,
): string {
  const zoneNote = viewerZone === owner.timeZone ? "" : ` (${owner.timeZone} time)`
  switch (schedule.kind) {
    case "once":
      return `once, ${formatInstant(schedule.at, viewerZone, now)}`
    case "calendar": {
      const at = `at ${clockTime(schedule.hour ?? owner.preferredHour, schedule.minute ?? 0)}`
      const start = dateParts(schedule.start)
      if (schedule.unit === "day") {
        return `${every(schedule.every, "day", "daily")} ${at}${zoneNote}`
      }
      if (schedule.unit === "week") {
        const days = [...(schedule.weekdays ?? [start.weekday])].sort((a, b) => a - b)
        const on = list(days.map((d) => WD[d] ?? "?"))
        return `${every(schedule.every, "week", "weekly")} on ${on} ${at}${zoneNote}`
      }
      const day = ordinal(schedule.dayOfMonth ?? start.day)
      return `${every(schedule.every, "month", "monthly")} on the ${day} ${at}${zoneNote}`
    }
    case "poll":
      return schedule.every === 1
        ? `every ${schedule.unit}`
        : `every ${schedule.every} ${schedule.unit}s`
    case "period": {
      const cadence =
        schedule.every === 1
          ? `every ${schedule.unit}`
          : `every ${schedule.every} ${schedule.unit}s`
      const days = schedule.leadDays === 1 ? "day" : "days"
      const lead = schedule.leadDays ? `, ${schedule.leadDays} ${days} ahead` : ""
      return `${cadence} from ${schedule.anchor}${lead}`
    }
  }
}
