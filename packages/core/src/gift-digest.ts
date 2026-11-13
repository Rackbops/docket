import type { GiftOccasion, GiftOccasionRecipient, GiftRecipient } from "./gift-model.js"
import { type GiftBucket, giftCoverage } from "./gift-rules.js"
import type { User } from "./model.js"
import { daysUntil } from "./schedule.js"
import { wallClock } from "./zoned.js"

/**
 * Gift occasion digests (docket#103, design docket#92 "Capture, discovery, and notifications";
 * plan 5.3: the notify lane, no model call). An occasion the owner opted in to (`digest`) gets at
 * most one digest a day, at the owner's preferred hour in their zone, and only when it would say
 * something new or its shop-by day is near; an unchanged day stays quiet.
 *
 * `decideGiftDigest` is pure: the host reads the records, asks it, sends the text it returns, and
 * stores any `state` it returns (a sent digest's, or a quiet `nothing`'s) for next time, keyed by
 * occasion. `giftDigestKey` names the day's
 * send for the host's exactly-once claim (`Store.claimNotice`), so a retried tick never sends
 * twice.
 *
 * The text names people and counts only: never a price, a note or an item's title, so a DM preview
 * shows nothing the owner would mind seen on a lock screen. The occasion's title and the people's
 * names are the owner's own words.
 */

/** Days before the shop-by day (or the occasion's date, when it has none) that count as near. */
export const GIFT_DIGEST_NEAR_DAYS = 3

/** People named in one digest; the rest are counted. */
export const GIFT_DIGEST_NAMES_MAX = 10

/** What the host keeps between digests for one occasion. */
export interface GiftDigestState {
  /** The owner's local day (`YYYY-MM-DD`) the last digest was sent on. */
  sentOn: string | null
  /** What the last digest said, as an opaque key: a new one means something material changed. */
  fingerprint: string | null
}

export interface GiftDigestInput {
  occasion: GiftOccasion
  /** The owner's roster rows; only this occasion's live rows are read. */
  roster: readonly GiftOccasionRecipient[]
  /** `giftBuckets` over every allocation and purchase of the owner. */
  buckets: readonly GiftBucket[]
  /** The owner's recipients, for names. */
  recipients: readonly GiftRecipient[]
  owner: Pick<User, "timeZone" | "preferredHour">
  now: Date
  /** What the host stored after the last digest; null before the first. */
  last: GiftDigestState | null
}

export type GiftDigestQuiet =
  /** Not opted in, or the occasion is archived. */
  | "off"
  /** The occasion's date has passed. */
  | "past"
  /** Before the owner's preferred hour today. */
  | "not-yet"
  /** One was sent today already. */
  | "sent-today"
  /** Everyone is covered and nothing is on its way: nothing to say. */
  | "nothing"
  /** The same as the last digest, and the shop-by day is not near. */
  | "unchanged"

export type GiftDigestDecision =
  | {
      due: false
      reason: GiftDigestQuiet
      /**
       * With `nothing`: store this in place of the last state, so that what the last digest said
       * coming back later (a returned gift) reads as a change and is sent.
       */
      state?: GiftDigestState
    }
  | {
      due: true
      text: string
      /** Store this; pass it back as `last`. */
      state: GiftDigestState
      /**
       * Whole days to the shop-by day, or to the date when there is none; null when the occasion
       * has neither.
       */
      daysLeft: number | null
    }

/** The exactly-once key for one occasion's digest on one local day. */
export function giftDigestKey(occasionId: string, day: string): string {
  return `gift-digest:${occasionId}:${day}`
}

const pad = (n: number) => String(n).padStart(2, "0")

/** FNV-1a over the text, in base 36: a short, stable key, not a secret. */
function hash(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const ch of text) {
    h ^= BigInt(ch.codePointAt(0) ?? 0)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(36)
}

/**
 * Whether a digest is due for `input.occasion` now, and its text. Who still needs a gift: roster
 * people not done and short of their target in gifts bought (`giftCoverage` status
 * `needs-planning` or `planned`; with no target, one gift). Awaiting arrival: this occasion's
 * gifts bought and not yet arrived, whoever they are for. A digest is due at or after the owner's
 * preferred hour, once a local day, when either is non-empty and either changed since the last
 * state stored or the shop-by day (the date, when there is none) is 0 to `GIFT_DIGEST_NEAR_DAYS`
 * days away. Everything is counted in the owner's zone -- the hour, the day, the days left and
 * whether the date has passed -- so "today" in the text is the owner's today.
 */
export function decideGiftDigest(input: GiftDigestInput): GiftDigestDecision {
  const { occasion, owner, now, last } = input
  if (occasion.digest !== true || occasion.archived) return { due: false, reason: "off" }
  const zone = owner.timeZone
  if (occasion.date !== null && (daysUntil(occasion.date, now, zone) ?? 0) < 0) {
    return { due: false, reason: "past" }
  }
  const local = wallClock(now, zone)
  const today = `${local.year}-${pad(local.month)}-${pad(local.day)}`
  if (local.hour < owner.preferredHour) return { due: false, reason: "not-yet" }
  if (last?.sentOn === today) return { due: false, reason: "sent-today" }

  const rows = input.roster.filter((r) => r.occasionId === occasion.id && !r.archived)
  const needing = rows
    .map((r) => giftCoverage(r, input.buckets))
    .filter((c) => !c.done && (c.status === "needs-planning" || c.status === "planned"))
    .map((c) => c.recipientId)
    .sort()
  const awaiting = input.buckets.filter(
    (b) => b.occasionId === occasion.id && b.stage === "purchased",
  ).length
  const fingerprint = hash(JSON.stringify([needing, awaiting]))
  if (needing.length === 0 && awaiting === 0) {
    return { due: false, reason: "nothing", state: { sentOn: last?.sentOn ?? null, fingerprint } }
  }

  const shopBy = occasion.deadline ?? occasion.date
  const daysLeft = shopBy === null ? null : daysUntil(shopBy, now, zone)
  const near = daysLeft !== null && daysLeft >= 0 && daysLeft <= GIFT_DIGEST_NEAR_DAYS
  if (fingerprint === last?.fingerprint && !near) return { due: false, reason: "unchanged" }

  const names = needing.map(
    (id) => input.recipients.find((r) => r.id === id)?.displayName ?? "someone",
  )
  const lines = [`Gifts for ${occasion.title}`]
  if (daysLeft !== null) {
    const byDeadline = occasion.deadline !== undefined && occasion.deadline !== null
    const what = byDeadline ? "to shop" : "to go"
    if (daysLeft > 1) lines.push(`${daysLeft} days ${what}.`)
    else if (daysLeft === 1) lines.push(`1 day ${what}.`)
    else if (daysLeft === 0) lines.push(byDeadline ? "Today is the shop-by day." : "It is today.")
    else lines.push("The shop-by day has passed.")
  }
  if (names.length > 0) {
    const shown = names.slice(0, GIFT_DIGEST_NAMES_MAX)
    const more = names.length - shown.length
    lines.push(`Still needs a gift: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`)
  }
  if (awaiting > 0) lines.push(`${awaiting} ${awaiting === 1 ? "gift" : "gifts"} awaiting arrival.`)
  return { due: true, text: lines.join("\n"), state: { sentOn: today, fingerprint }, daysLeft }
}
