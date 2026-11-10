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

/** An allocation a sync would leave pointing at someone no longer on the roster. */
export interface GiftSyncAffected {
  allocationId: string
  revision: number
  recipientIds: string[]
  /** The recipients the sync drops from it. */
  dropped: string[]
  /** It has a purchase behind it (bought gifts are never lost: keep, reassign or unassign). */
  bought: boolean
}

export interface GiftSyncRemoval {
  row: GiftOccasionRecipient
  coverage: GiftCoverage
}

/**
 * A reviewed sync of an open occasion's roster with its groups as they are now: who would be
 * added, who removed (with their coverage and per-recipient budget), and every live allocation
 * on the occasion that names a removed recipient. Nothing is written. A row whose recipient is
 * added back is restored (`restore`), not created again, since its archived row holds its place.
 */
export interface GiftSyncPreview {
  occasionId: string
  occasionRevision: number
  added: string[]
  /** Archived rows to restore for recipients added back. */
  restore: GiftOccasionRecipient[]
  removed: GiftSyncRemoval[]
  affected: GiftSyncAffected[]
  /** The change to the sum of per-recipient budgets: removed rows' budgets leave it. */
  budgetDeltaMinor: number
}

/**
 * `roster` is every row of this occasion, archived ones included; `allocations` every allocation
 * of the owner; `buckets` from `giftBuckets` over the owner's whole lists. An archived occasion
 * is never synced: it keeps the roster it had.
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
  const mine = roster.filter((r) => r.occasionId === occasion.id)
  const live = mine.filter((r) => !r.archived)
  const want = rosterIds(
    previewRoster(chosenGroups(occasion, groups), occasion.includeIds, occasion.excludeIds),
  )
  const added = want.filter((id) => !live.some((r) => r.recipientId === id))
  const restore = mine.filter((r) => r.archived && added.includes(r.recipientId))
  const removedRows = live.filter((r) => !want.includes(r.recipientId))
  const removed = removedRows.map((row) => ({ row, coverage: giftCoverage(row, buckets) }))
  const gone = new Set(removedRows.map((r) => r.recipientId))
  const affected: GiftSyncAffected[] = []
  for (const a of allocations) {
    if (a.archived || a.occasionId !== occasion.id) continue
    const dropped = a.recipientIds.filter((id) => gone.has(id))
    if (dropped.length === 0) continue
    affected.push({
      allocationId: a.id,
      revision: a.revision,
      recipientIds: [...a.recipientIds],
      dropped,
      bought: a.purchaseId !== null,
    })
  }
  const budgetDeltaMinor = -removedRows.reduce((n, r) => n + (r.budgetMinor ?? 0), 0)
  return {
    occasionId: occasion.id,
    occasionRevision: occasion.revision,
    added,
    restore,
    removed,
    affected,
    budgetDeltaMinor,
  }
}

/** The writes a decided sync makes, in order. */
export interface GiftSyncPlan {
  occasionId: string
  createRows: string[]
  restoreRows: { id: string; revision: number }[]
  archiveRows: { id: string; revision: number }[]
  allocations: {
    id: string
    revision: number
    patch: Partial<GiftAllocationFields> & { archived?: boolean }
  }[]
}

/**
 * Turns a preview and the owner's decisions into writes. Every affected allocation needs a
 * decision, or nothing is planned: `GiftValidationError` names each one without. `keep` leaves
 * the gift as it is (bought gifts are never dropped by a sync); `reassign` points it at the
 * recipients given; `unassign` takes the dropped recipients off it, and archives it when nobody
 * is left, so its units go back to the stash.
 */
export function planGroupSync(
  preview: GiftSyncPreview,
  decisions: Readonly<Record<string, GiftSyncDecision>>,
): GiftSyncPlan {
  const missing = preview.affected.filter((a) => decisions[a.allocationId] === undefined)
  if (missing.length > 0) {
    throw new GiftValidationError(
      missing.map((a) => `allocation ${a.allocationId} needs keep, reassign or unassign`),
    )
  }
  const plan: GiftSyncPlan = {
    occasionId: preview.occasionId,
    createRows: preview.added.filter((id) => !preview.restore.some((r) => r.recipientId === id)),
    restoreRows: preview.restore.map((r) => ({ id: r.id, revision: r.revision })),
    archiveRows: preview.removed.map((r) => ({ id: r.row.id, revision: r.row.revision })),
    allocations: [],
  }
  for (const a of preview.affected) {
    const d = decisions[a.allocationId] as GiftSyncDecision
    if (d.action === "keep") continue
    if (d.action === "reassign") {
      if (d.recipientIds.length === 0) {
        throw new GiftValidationError([`allocation ${a.allocationId}: reassign names nobody`])
      }
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
