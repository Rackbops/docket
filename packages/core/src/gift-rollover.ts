import { previewRoster, resolveGroups, rosterIds } from "./gift-groups.js"
import type {
  GiftAllocation,
  GiftGroup,
  GiftOccasion,
  GiftOccasionFields,
  GiftOccasionRecipient,
  GiftRecipient,
} from "./gift-model.js"
import { GiftValidationError } from "./gift-ports.js"
import { giftProblems } from "./gift-validate.js"

/**
 * "Set up next year" (docket#99, plan item 158): a reviewed copy of an occasion -- Christmas 2027
 * from Christmas 2026. Pure: `previewGiftRollover` reads records and returns what would be made;
 * `GiftLedger.applyGiftRollover` makes it, and nothing is written until then. The old occasion is
 * never changed, archived or not, so its purchases, states and history stay readable.
 *
 * Carried: the occasion's own settings (its title's year moved on, its date a year later), its
 * people -- the groups re-resolved against today's membership and labels, plus the hand-picked
 * overrides -- each staying person's target and budget, and only the ideas the owner picks. Never
 * carried: any purchase, received, wrapped, ready or given state, or a gift with a purchase behind
 * it; each person's decision starts again at planning (a carried target of 0 still reads as
 * skipped until it is changed).
 */

/** One person on the new roster, with what carries over from their row on the old one. */
export interface GiftRolloverRow {
  recipientId: string
  target: number | null
  budgetMinor: number | null
  /** They had a live row on the old occasion (their target and budget come from it). */
  carried: boolean
}

/** A picked idea: an unbought gift on the old occasion, planned again for the people still on. */
export interface GiftRolloverIdea {
  fromAllocationId: string
  itemId: string
  recipientIds: string[]
  /** Its recipients who will not be on the new roster, left off the copy. */
  dropped: string[]
  quantity: number
  shared: boolean
}

export interface GiftRolloverPreview {
  fromOccasionId: string
  /** The revisions read: applying refuses the preview if the occasion or a group moved since. */
  fromRevision: number
  groupRevisions: Record<string, number>
  occasion: GiftOccasionFields
  roster: GiftRolloverRow[]
  /** People on the old occasion's live roster who will not be on the new one. */
  leftOff: string[]
  ideas: GiftRolloverIdea[]
  /** The old occasion's gifts the owner may pick: live, with no purchase and nothing handed off. */
  pickable: string[]
}

export interface GiftRolloverInput {
  occasion: GiftOccasion
  /** Every group the occasion names (archived ones too); a missing one is refused. */
  groups: readonly GiftGroup[]
  /** Every recipient of the owner, archived ones too. */
  recipients: readonly GiftRecipient[]
  /** The old occasion's roster rows, archived ones too. */
  roster: readonly GiftOccasionRecipient[]
  /** The owner's allocations; only the old occasion's are read. */
  allocations: readonly GiftAllocation[]
  /** The allocation ids of the ideas to carry; each must be in `pickable`. */
  pick?: readonly string[]
  /** The new title; default: the old one with its year moved on. */
  title?: string
  /**
   * The new date; default: a year after the old one (29 February becomes the 28th). The new year
   * is this date's year, or the old year moved on when the date is null.
   */
  date?: string | null
}

function nextYearDate(date: string | null): string | null {
  if (date === null) return null
  const [y, m, d] = date.split("-")
  const year = String(Number(y) + 1).padStart(4, "0")
  const leap = (n: number) => (n % 4 === 0 && n % 100 !== 0) || n % 400 === 0
  const day = m === "02" && d === "29" && !leap(Number(year)) ? "28" : d
  return `${year}-${m}-${day}`
}

function nextTitle(title: string, year: number | null, date: string | null): string {
  if (year === null && date !== null) year = Number(date.slice(0, 4))
  if (year === null) return title
  return title.replace(new RegExp(`\\b${year}\\b`, "g"), String(year + 1))
}

/** What setting up the next occurrence of `input.occasion` would make; nothing is written. */
export function previewGiftRollover(input: GiftRolloverInput): GiftRolloverPreview {
  const old = input.occasion
  const problems: string[] = []
  const chosen = old.groupIds.map((id) => {
    const g = input.groups.find((x) => x.id === id)
    if (g === undefined) throw new GiftValidationError([`occasion names group ${id}, not given`])
    return g
  })
  const live = new Set(input.recipients.filter((r) => !r.archived).map((r) => r.id))
  const want = rosterIds(
    previewRoster(resolveGroups(chosen, input.recipients), old.includeIds, old.excludeIds),
  ).filter((id) => live.has(id))
  const oldRows = input.roster.filter((r) => r.occasionId === old.id && !r.archived)
  const roster = want.map((recipientId): GiftRolloverRow => {
    const row = oldRows.find((r) => r.recipientId === recipientId)
    return {
      recipientId,
      target: row?.target ?? null,
      budgetMinor: row?.budgetMinor ?? null,
      carried: row !== undefined,
    }
  })
  const mine = input.allocations.filter((a) => a.occasionId === old.id && !a.archived)
  const pickable = mine
    .filter((a) => a.purchaseId === null && a.handoff === "none")
    .map((a) => a.id)
  const ideas: GiftRolloverIdea[] = []
  for (const id of input.pick ?? []) {
    const a = mine.find((x) => x.id === id)
    if (a === undefined) {
      problems.push(`allocation ${id} is not a live gift on this occasion`)
    } else if (!pickable.includes(id)) {
      problems.push(`allocation ${id} was bought or handed off: it is never carried`)
    } else if (ideas.some((i) => i.fromAllocationId === id)) {
      problems.push(`allocation ${id} is picked twice`)
    } else {
      const recipientIds = a.recipientIds.filter((r) => want.includes(r))
      if (recipientIds.length === 0) {
        problems.push(`allocation ${id}: nobody it is for is on the new roster`)
      }
      ideas.push({
        fromAllocationId: id,
        itemId: a.itemId,
        recipientIds,
        dropped: a.recipientIds.filter((r) => !want.includes(r)),
        quantity: a.quantity,
        shared: a.shared,
      })
    }
  }
  const date = input.date === undefined ? nextYearDate(old.date) : input.date
  const dateYear = date === null ? null : Number(date.slice(0, 4))
  const occasion: GiftOccasionFields = {
    kind: old.kind,
    title: input.title ?? nextTitle(old.title, old.year, old.date),
    date,
    timeZone: old.timeZone,
    year: old.year === null ? null : date === null ? old.year + 1 : dateYear,
    currency: old.currency,
    budgetMinor: old.budgetMinor,
    groupIds: [...old.groupIds],
    includeIds: [...old.includeIds],
    excludeIds: [...old.excludeIds],
  }
  problems.push(...giftProblems("occasion", occasion))
  if (problems.length > 0) throw new GiftValidationError(problems)
  return {
    fromOccasionId: old.id,
    fromRevision: old.revision,
    groupRevisions: Object.fromEntries(chosen.map((g) => [g.id, g.revision])),
    occasion,
    roster,
    leftOff: oldRows.map((r) => r.recipientId).filter((id) => !want.includes(id)),
    ideas,
    pickable,
  }
}
