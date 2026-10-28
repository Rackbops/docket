/**
 * Zone-aware wall-clock arithmetic on Intl alone (plan section 5.3): no Temporal, no library. A
 * schedule says "9:00 in America/New_York"; the tracker needs the instant that is on a given day,
 * correct across daylight-saving changes.
 */

export interface WallClock {
  year: number
  /** 1-12 */
  month: number
  /** 1-31 */
  day: number
  /** 0-23 */
  hour: number
  minute: number
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
    formatters.set(zone, f)
  }
  return f
}

/** True when Intl knows `zone` as an IANA time zone. */
export function isTimeZone(zone: string): boolean {
  try {
    formatter(zone)
    return true
  } catch {
    return false
  }
}

/** The wall clock in `zone` at `instant`. Throws a RangeError on an unknown zone. */
export function wallClock(instant: Date, zone: string): WallClock {
  const parts = formatter(zone).formatToParts(instant)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  }
}

/** Minutes east of UTC that `zone` observes at `instant` (New York in winter: -300). */
export function zoneOffsetMinutes(instant: Date, zone: string): number {
  const w = wallClock(instant, zone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute)
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000
  return Math.round((asUtc - truncated) / 60_000)
}

function reads(instant: number, zone: string, d: number, h: number, min: number): boolean {
  const w = wallClock(new Date(instant), zone)
  return w.day === d && w.hour === h && w.minute === min
}

/**
 * The instant at which `zone`'s wall clock reads the given date and time. A time inside a
 * spring-forward gap (02:30 on the night clocks jump from 02:00 to 03:00) resolves one hour
 * later, to 03:30, as most calendar software does; an ambiguous fall-back time resolves to its
 * first occurrence.
 */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute)
  // Sample the zone's offset a day either side as well as at the wanted time: east of UTC both
  // samples near an ambiguous fall-back time land after the switch, so only the day-before
  // offset finds the first occurrence.
  const offsets = new Set<number>()
  for (const at of [wanted - 86_400_000, wanted, wanted + 86_400_000]) {
    offsets.add(zoneOffsetMinutes(new Date(at), zone))
  }
  const candidates = [...offsets].map((offset) => wanted - offset * 60_000)
  const matching = candidates.filter((c) => reads(c, zone, day, hour, minute))
  if (matching.length > 0) return new Date(Math.min(...matching))
  // No offset reads back the wanted time: it fell into a gap. Resolve forward.
  return new Date(Math.max(...candidates))
}
