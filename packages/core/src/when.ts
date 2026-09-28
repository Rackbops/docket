import { wallClock, zonedInstant } from "./zoned.js"

/**
 * Reading a person's "when" (plan section 1.4, the reminder's `at` option): the words a person
 * types into a slash command, resolved in their own zone. The grammar is small on purpose -- a
 * relative offset, a day, a time, or an ISO instant -- so a misread is an error the person
 * sees, never a reminder at a surprising hour.
 *
 *   in 20 minutes | in 2h | in a day | in 3 weeks
 *   9am | 17:30 | noon | midnight          (today, or tomorrow once it has passed)
 *   tomorrow | friday | 2026-10-01 | 10/1  (at the default hour)
 *   tomorrow 9am | fri at 17:30 | 9am tomorrow | on 10/1 at noon
 *   2026-10-01T13:00:00Z                   (an ISO instant with an offset)
 */

export type WhenResult = { ok: true; at: Date } | { ok: false; error: string }

export interface WhenOptions {
  /** The person's IANA zone. */
  zone: string
  /** The hour a day without a time resolves to: the person's preferred hour. */
  defaultHour: number
}

const UNITS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

const ISO_RE = /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/
const RELATIVE_RE = /^in (\d+|an?) ?([a-z]+)$/
const DAY = String.raw`today|tomorrow|tmrw|[a-z]{3,9}|\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}`
const TIME = String.raw`noon|midnight|\d{1,2}(?::\d{2})? ?(?:am|pm)?`
const DAY_TIME_RE = new RegExp(`^(?:on )?(${DAY})(?: (?:at )?(${TIME}))?$`)
const TIME_DAY_RE = new RegExp(`^(?:at )?(${TIME})(?: (?:on )?(${DAY}))?$`)

const MAX_AHEAD_YEARS = 5
const MAX_AHEAD_MS = MAX_AHEAD_YEARS * 365.25 * 86_400_000

function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const HINT = `Try "in 2 hours", "9am", "tomorrow 9am", "friday 17:30" or "2026-10-01 9:00".`

interface CalendarDate {
  year: number
  month: number
  day: number
}

function fail(text: string, why?: string): WhenResult {
  return { ok: false, error: `${why ?? `I couldn't read "${text}" as a time.`} ${HINT}` }
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

function validDate(date: CalendarDate): boolean {
  return (
    date.month >= 1 &&
    date.month <= 12 &&
    date.day >= 1 &&
    date.day <= daysIn(date.year, date.month)
  )
}

/** `9am` -> 9:00, `12am` -> 0:00, `17:30` -> 17:30; null when out of range. */
function parseTime(word: string): { hour: number; minute: number } | null {
  if (word === "noon") return { hour: 12, minute: 0 }
  if (word === "midnight") return { hour: 0, minute: 0 }
  const m = /^(\d{1,2})(?::(\d{2}))? ?(am|pm)?$/.exec(word)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] === undefined ? 0 : Number(m[2])
  const meridiem = m[3]
  if (minute > 59) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0)
  } else if (hour > 23) {
    return null
  }
  return { hour, minute }
}

function weekday(word: string): number {
  if (word.length < 3) return -1
  return WEEKDAYS.findIndex((d) => d.startsWith(word))
}

/**
 * Resolves the person's words to an instant after `now` and at most five years ahead, or says
 * why it cannot.
 */
export function parseWhen(text: string, now: Date, options: WhenOptions): WhenResult {
  const result = resolve(text, now, options)
  if (result.ok && result.at.getTime() - now.getTime() > MAX_AHEAD_MS) {
    return fail(text, `${text} is more than ${MAX_AHEAD_YEARS} years away.`)
  }
  return result
}

function resolve(text: string, now: Date, options: WhenOptions): WhenResult {
  const words = text.trim().toLowerCase().replace(/\s+/g, " ").replace(/,/g, "")
  if (words === "") return fail(text, "Say when.")

  if (ISO_RE.test(words)) {
    const [year, month, day] = words.slice(0, 10).split("-").map(Number)
    if (!validDate({ year: year ?? 0, month: month ?? 0, day: day ?? 0 }))
      return fail(text, `${words.slice(0, 10)} is not a date.`)
    const at = new Date(Date.parse(words.toUpperCase()))
    if (Number.isNaN(at.getTime())) return fail(text)
    return at > now ? { ok: true, at } : fail(text, `${text} has already passed.`)
  }

  const rel = RELATIVE_RE.exec(words)
  if (rel) {
    const n = rel[1] === "a" || rel[1] === "an" ? 1 : Number(rel[1])
    const unit = UNITS[rel[2] ?? ""]
    if (unit === undefined || n < 1) return fail(text)
    if (n * unit > MAX_AHEAD_MS)
      return fail(text, `${text} is more than ${MAX_AHEAD_YEARS} years away.`)
    return { ok: true, at: new Date(now.getTime() + n * unit) }
  }

  if (!knownZone(options.zone)) return fail(text, `I don't know the time zone ${options.zone}.`)

  let dayWord: string | undefined
  let timeWord: string | undefined
  const timeFirst = TIME_DAY_RE.exec(words)
  const dayFirst = DAY_TIME_RE.exec(words)
  if (timeFirst && parseTime(timeFirst[1] ?? "")) {
    timeWord = timeFirst[1]
    dayWord = timeFirst[2]
  } else if (dayFirst) {
    dayWord = dayFirst[1]
    timeWord = dayFirst[2]
  } else {
    return fail(text)
  }

  const time =
    timeWord === undefined ? { hour: options.defaultHour, minute: 0 } : parseTime(timeWord)
  if (!time) return fail(text)

  const clock = wallClock(now, options.zone)
  const today: CalendarDate = { year: clock.year, month: clock.month, day: clock.day }
  const at = (date: CalendarDate) =>
    zonedInstant(date.year, date.month, date.day, time.hour, time.minute, options.zone)

  if (dayWord === undefined) {
    const first = at(today)
    return { ok: true, at: first > now ? first : at(addDays(today, 1)) }
  }
  if (dayWord === "today") {
    const when = at(today)
    return when > now ? { ok: true, at: when } : fail(text, `${text} has already passed.`)
  }
  if (dayWord === "tomorrow" || dayWord === "tmrw") return { ok: true, at: at(addDays(today, 1)) }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayWord)
  if (iso) {
    const date = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
    if (!validDate(date)) return fail(text, `${dayWord} is not a date.`)
    const when = at(date)
    return when > now ? { ok: true, at: when } : fail(text, `${text} has already passed.`)
  }

  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(dayWord)
  if (md) {
    const month = Number(md[1])
    const day = Number(md[2])
    if (month === today.month && day === today.day) {
      const when = at(today)
      return when > now ? { ok: true, at: when } : fail(text, `${text} has already passed.`)
    }
    // The next such date: this year's if it is still ahead, else the first year it exists (2/29).
    for (let year = today.year; year <= today.year + 4; year++) {
      const date = { year, month, day }
      if (validDate(date) && at(date) > now) return { ok: true, at: at(date) }
    }
    return fail(text, `${dayWord} is not a date.`)
  }

  const wd = weekday(dayWord)
  if (wd === -1) return fail(text)
  const ahead = (wd - clock.weekday + 7) % 7
  const sameDay = at(addDays(today, ahead))
  return { ok: true, at: sameDay > now ? sameDay : at(addDays(today, ahead + 7)) }
}
