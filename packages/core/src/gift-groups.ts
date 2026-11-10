import type {
  GiftAllocation,
  GiftAllocationFields,
  GiftGroup,
  GiftOccasion,
  GiftOccasionRecipient,
} from "./gift-model.js"
import { GiftValidationError } from "./gift-ports.js"
import { type GiftBucket, type GiftCoverage, giftCoverage } from "./gift-rules.js"

/**
 * Groups, membership edits and occasion rosters (plan item 158, docket#97). Pure: each function
 * reads records and returns what to write; `applyGiftSync` in `gift-ledger.ts` writes it. A
 * group is a list of recipient ids and nothing else: membership never depends on a label.
 */

/** A reviewed membership edit: what would really change, and the group's next `memberIds`. */
export interface GiftMembershipEdit {
  added: string[]
  removed: string[]
  memberIds: string[]
}

/**
 * Adds and removes members (one or many). Already-present adds and absent removes change
 * nothing; order is kept, adds go at the end. Removing a member never touches the person,
 * their gifts or their history: it is only this list. Apply with `GiftLedger.update` at the
 * revision the preview was read at.
 */
export function editGroupMembers(
  group: Pick<GiftGroup, "memberIds">,
  add: readonly string[],
  remove: readonly string[],
): GiftMembershipEdit {
  const drop = new Set(remove)
  const kept = group.memberIds.filter((id) => !drop.has(id))
  const removed = group.memberIds.filter((id) => drop.has(id))
  const added: string[] = []
  for (const id of add) {
    if (!kept.includes(id) && !added.includes(id) && !drop.has(id)) added.push(id)
  }
  return { added, removed, memberIds: [...kept, ...added] }
}

/** One recipient in a roster preview, with where they came from. */
export interface GiftRosterEntry {
  recipientId: string
  /** The chosen groups they are in, in the order the groups were chosen. */
  groupIds: string[]
  /** Added by hand (`includeIds`), whatever the groups say. */
  included: boolean
  /** Left out by hand (`excludeIds`): shown, never on the roster. */
  excluded: boolean
}

/**
 * The unique recipients a choice of groups and overrides gives: each person once, however many
 * chosen groups hold them (Aunts and Cousins sharing one member is one entry). Order: the groups
 * in the order chosen, each group's members in order, then hand-added ones. Excluded people are
 * listed with `excluded: true` so the override stays visible; `rosterIds` leaves them out.
 * Archived groups count like any other: the choice was made.
 */
export function previewRoster(
  groups: readonly Pick<GiftGroup, "id" | "memberIds">[],
  includeIds: readonly string[],
  excludeIds: readonly string[],
): GiftRosterEntry[] {
  const out = new Map<string, GiftRosterEntry>()
  const entry = (recipientId: string): GiftRosterEntry => {
    let e = out.get(recipientId)
    if (e === undefined) {
      e = { recipientId, groupIds: [], included: false, excluded: excludeIds.includes(recipientId) }
      out.set(recipientId, e)
    }
    return e
  }
  for (const g of groups) {
    for (const id of g.memberIds) {
      const e = entry(id)
      if (!e.groupIds.includes(g.id)) e.groupIds.push(g.id)
    }
  }
  for (const id of includeIds) entry(id).included = true
  for (const id of excludeIds) entry(id)
  return [...out.values()]
}

/** The recipient ids a roster preview puts on the occasion. */
export function rosterIds(entries: readonly GiftRosterEntry[]): string[] {
  return entries.filter((e) => !e.excluded).map((e) => e.recipientId)
}

/** The groups an occasion names, in its order; a missing group is an error, not silence. */
function chosenGroups(occasion: GiftOccasion, groups: readonly GiftGroup[]): GiftGroup[] {
  return occasion.groupIds.map((id) => {
    const g = groups.find((x) => x.id === id)
    if (g === undefined) throw new GiftValidationError([`occasion names group ${id}, not given`])
    return g
  })
}

/** What to do with an allocation that names a recipient a sync drops. */
export type GiftSyncDecision =
  | { action: "keep" }
  | { action: "reassign"; recipientIds: string[] }
  | { action: "unassign" }

/** A live allocation on the occasion naming someone who will not be on its roster. */
export interface GiftSyncAffected {
  allocationId: string
  revision: number
  recipientIds: string[]
  /** Its recipients who will not be on the roster. */
  dropped: string[]
  /** It has a purchase behind it (bought gifts are never lost: keep, reassign or unassign). */
  bought: boolean
}

/** Someone a sync puts on the roster, with what they bring: a restored row keeps its budget. */
export interface GiftSyncAddition {
  recipientId: string
  /** The archived row restored for them, or null when a new row is created. */
  restore: GiftOccasionRecipient | null
  coverage: GiftCoverage
}

export interface GiftSyncRemoval {
  row: GiftOccasionRecipient
  coverage: GiftCoverage
}

/**
 * A reviewed sync of an open occasion's roster with its groups as they are now. Nothing is
 * written. `added` and `removed` carry each person's coverage (from the gifts already on the
 * occasion) and the row budget that comes or goes. `affected` is every live allocation on the
 * occasion naming someone who will not be on the roster -- whether their row goes in this sync
 * or went earlier -- so a gift on someone off the roster is asked about at every sync and never
 * forgotten, even after a sync that stopped half way. The roster is the groups and overrides: a
 * row added by hand without `includeIds` is offered for removal.
 */
export interface GiftSyncPreview {
  occasionId: string
  occasionRevision: number
  /** The revisions of the occasion's groups as read; a plan is refused if one moved. */
  groupRevisions: Record<string, number>
  /** The roster after the sync. */
  roster: string[]
  added: GiftSyncAddition[]
  removed: GiftSyncRemoval[]
  affected: GiftSyncAffected[]
  /** The change to the sum of row budgets: restored rows' budgets come back, removed ones go. */
  budgetDeltaMinor: number
}

/**
 * `roster` is every row of this occasion, archived ones included; `groups` every group the
 * occasion names (archived ones too: pass `includeArchived`), a missing one is an error;
 * `allocations` every allocation of the owner; `buckets` from `giftBuckets` over the owner's
 * whole lists. An archived occasion is never synced: it keeps the roster it had.
 */
export function previewGroupSync(
  occasion: GiftOccasion,
  groups: readonly GiftGroup[],
  roster: readonly GiftOccasionRecipient[],
  allocations: readonly GiftAllocation[],
  buckets: readonly GiftBucket[],
): GiftSyncPreview {
  if (occasion.archived) {
    throw new GiftValidationError(["an archived occasion keeps its roster; it is never synced"])
  }
  const chosen = chosenGroups(occasion, groups)
  const mine = roster.filter((r) => r.occasionId === occasion.id)
  const live = mine.filter((r) => !r.archived)
  const want = rosterIds(previewRoster(chosen, occasion.includeIds, occasion.excludeIds))
  const added = want
    .filter((id) => !live.some((r) => r.recipientId === id))
    .map((recipientId) => {
      const restore = mine.find((r) => r.archived && r.recipientId === recipientId) ?? null
      const row = restore ?? {
        occasionId: occasion.id,
        recipientId,
        target: null,
        decision: "planning" as const,
      }
      return { recipientId, restore, coverage: giftCoverage(row as GiftOccasionRecipient, buckets) }
    })
  const removedRows = live.filter((r) => !want.includes(r.recipientId))
  const removed = removedRows.map((row) => ({ row, coverage: giftCoverage(row, buckets) }))
  const affected: GiftSyncAffected[] = []
  for (const a of allocations) {
    if (a.archived || a.occasionId !== occasion.id) continue
    const dropped = a.recipientIds.filter((id) => !want.includes(id))
    if (dropped.length === 0) continue
    affected.push({
      allocationId: a.id,
      revision: a.revision,
      recipientIds: [...a.recipientIds],
      dropped,
      bought: a.purchaseId !== null,
    })
  }
  const back = added.reduce((n, a) => n + (a.restore?.budgetMinor ?? 0), 0)
  const gone = removedRows.reduce((n, r) => n + (r.budgetMinor ?? 0), 0)
  return {
    occasionId: occasion.id,
    occasionRevision: occasion.revision,
    groupRevisions: Object.fromEntries(chosen.map((g) => [g.id, g.revision])),
    roster: want,
    added,
    removed,
    affected,
    budgetDeltaMinor: back - gone,
  }
}

/** The writes a decided sync makes, in the order `GiftLedger.applyGiftSync` makes them. */
export interface GiftSyncPlan {
  occasionId: string
  occasionRevision: number
  groupRevisions: Record<string, number>
  allocations: {
    id: string
    revision: number
    patch: Partial<GiftAllocationFields> & { archived?: boolean }
  }[]
  createRows: string[]
  restoreRows: { id: string; revision: number }[]
  archiveRows: { id: string; revision: number }[]
}

/**
 * Turns a preview and the owner's decisions into writes. Every affected allocation needs a
 * decision, and a decision for anything else is refused, or nothing is planned:
 * `GiftValidationError` names each problem. `keep` leaves the gift untouched (it is asked about
 * again next sync); `reassign` points it at recipients who will be on the roster; `unassign`
 * takes the dropped recipients off it, and archives it when nobody is left, so its units go back
 * to the stash.
 */
export function planGroupSync(
  preview: GiftSyncPreview,
  decisions: Readonly<Record<string, GiftSyncDecision>>,
): GiftSyncPlan {
  const problems: string[] = []
  for (const a of preview.affected) {
    const d = decisions[a.allocationId]
    if (d === undefined) {
      problems.push(`allocation ${a.allocationId} needs keep, reassign or unassign`)
    } else if (d.action === "reassign") {
      if (d.recipientIds.length === 0) {
        problems.push(`allocation ${a.allocationId}: reassign names nobody`)
      }
      if (new Set(d.recipientIds).size !== d.recipientIds.length) {
        problems.push(`allocation ${a.allocationId}: reassign repeats a recipient`)
      }
      for (const id of d.recipientIds) {
        if (!preview.roster.includes(id)) {
          problems.push(`allocation ${a.allocationId}: ${id} will not be on the roster`)
        }
      }
    }
  }
  for (const id of Object.keys(decisions)) {
    if (!preview.affected.some((a) => a.allocationId === id)) {
      problems.push(`allocation ${id} is not affected by this sync`)
    }
  }
  if (problems.length > 0) throw new GiftValidationError(problems)
  const plan: GiftSyncPlan = {
    occasionId: preview.occasionId,
    occasionRevision: preview.occasionRevision,
    groupRevisions: { ...preview.groupRevisions },
    allocations: [],
    createRows: preview.added.filter((a) => a.restore === null).map((a) => a.recipientId),
    restoreRows: preview.added.flatMap((a) =>
      a.restore === null ? [] : [{ id: a.restore.id, revision: a.restore.revision }],
    ),
    archiveRows: preview.removed.map((r) => ({ id: r.row.id, revision: r.row.revision })),
  }
  for (const a of preview.affected) {
    const d = decisions[a.allocationId] as GiftSyncDecision
    if (d.action === "keep") continue
    if (d.action === "reassign") {
      plan.allocations.push({
        id: a.allocationId,
        revision: a.revision,
        patch: { recipientIds: [...d.recipientIds] },
      })
      continue
    }
    const left = a.recipientIds.filter((id) => !a.dropped.includes(id))
    plan.allocations.push({
      id: a.allocationId,
      revision: a.revision,
      patch: left.length > 0 ? { recipientIds: left } : { archived: true },
    })
  }
  return plan
}

/** One occasion's budget: its own, and the sum of its live roster rows' budgets. */
export interface GiftOccasionBudget {
  currency: string
  budgetMinor: number | null
  recipientBudgetsMinor: number
  recipients: number
}

export function occasionBudget(
  occasion: GiftOccasion,
  roster: readonly GiftOccasionRecipient[],
): GiftOccasionBudget {
  const live = roster.filter((r) => r.occasionId === occasion.id && !r.archived)
  return {
    currency: occasion.currency,
    budgetMinor: occasion.budgetMinor,
    recipientBudgetsMinor: live.reduce((n, r) => n + (r.budgetMinor ?? 0), 0),
    recipients: live.length,
  }
}
