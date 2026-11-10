import type { GiftAllocation, GiftItem, GiftOccasionRecipient, GiftPurchase } from "./gift-model.js"

/**
 * The gift ledger's derived views (plan item 158, docket#96): how a purchase's units reach
 * recipients, how covered each roster row is, and what was spent. Pure functions over records
 * read from a `GiftStore`; nothing here writes or reads a store.
 */

/** Units an allocation holds: a shared gift is one set of units for all its recipients. */
export function allocationUnits(a: Pick<GiftAllocation, "shared" | "quantity" | "recipientIds">) {
  return a.shared ? a.quantity : a.quantity * a.recipientIds.length
}

/** Units ordered and not cancelled. Cancelled units were never charged. */
export function boughtUnits(p: GiftPurchase): number {
  return Math.max(0, p.ordered - p.cancelled)
}

/** Units ordered, less cancelled and returned: what allocations may hold. */
export function keptUnits(p: GiftPurchase): number {
  return Math.max(0, p.ordered - p.cancelled - p.returned)
}

/** Units received and not returned. */
export function arrivedUnits(p: GiftPurchase): number {
  return Math.max(0, p.received - p.returned)
}

/**
 * One gift as it reaches people: a recipient's own units from an allocation, or a shared
 * allocation's units for all its recipients together.
 */
export interface GiftBucket {
  allocationId: string
  occasionId: string
  recipientIds: string[]
  units: number
  /** Units of the purchase this bucket got, after cancellations and returns. */
  filled: number
  /** Of those, units that have arrived. */
  arrived: number
  stage: GiftStage
}

/** A gift's progress, least first. `given` is the owner's word, whatever the purchase says. */
export type GiftStage = "planned" | "purchased" | "arrived" | "ready" | "given"

const STAGES: readonly GiftStage[] = ["planned", "purchased", "arrived", "ready", "given"]

function stageOf(a: GiftAllocation, units: number, filled: number, arrived: number): GiftStage {
  if (a.handoff === "given") return "given"
  if (a.purchaseId === null || filled < units) return "planned"
  if (arrived < units) return "purchased"
  return a.handoff === "none" ? "arrived" : "ready"
}

function bucketsOf(a: GiftAllocation): { recipientIds: string[]; units: number }[] {
  return a.shared
    ? [{ recipientIds: [...a.recipientIds], units: a.quantity }]
    : a.recipientIds.map((id) => ({ recipientIds: [id], units: a.quantity }))
}

/**
 * Every live allocation's buckets, filled from their purchases. A purchase's kept units go to
 * its allocations in the order given (creation order, as `GiftStore.list` returns them), and
 * within one allocation to its recipients in order; so a return or cancellation empties the
 * last buckets filled and reopens only those gaps, and a replacement fills them again.
 * Archived allocations hold nothing and give no bucket; an archived purchase fills nothing.
 *
 * Pass every allocation and purchase of the owner, archived or not, in creation order: a subset
 * (one occasion's allocations, say) moves units between the gifts that share a purchase.
 */
export function giftBuckets(
  allocations: readonly GiftAllocation[],
  purchases: readonly GiftPurchase[],
): GiftBucket[] {
  const left = new Map<string, { kept: number; arrived: number }>()
  for (const p of purchases) {
    if (!p.archived) left.set(p.id, { kept: keptUnits(p), arrived: arrivedUnits(p) })
  }
  const out: GiftBucket[] = []
  for (const a of allocations) {
    if (a.archived) continue
    const pool = a.purchaseId === null ? undefined : left.get(a.purchaseId)
    for (const b of bucketsOf(a)) {
      const filled = pool === undefined ? 0 : Math.min(b.units, pool.kept)
      const arrived = pool === undefined ? 0 : Math.min(filled, pool.arrived)
      if (pool !== undefined) {
        pool.kept -= filled
        pool.arrived -= arrived
      }
      out.push({
        allocationId: a.id,
        occasionId: a.occasionId,
        recipientIds: b.recipientIds,
        units: b.units,
        filled,
        arrived,
        stage: stageOf(a, b.units, filled, arrived),
      })
    }
  }
  return out
}

/** Kept units of a purchase that no live allocation holds: a stash, covering nobody. */
export function stashUnits(purchase: GiftPurchase, allocations: readonly GiftAllocation[]): number {
  if (purchase.archived) return 0
  const held = allocations
    .filter((a) => !a.archived && a.purchaseId === purchase.id)
    .reduce((n, a) => n + allocationUnits(a), 0)
  return Math.max(0, keptUnits(purchase) - held)
}

export type GiftCoverageStatus =
  | "needs-planning"
  | "planned"
  | "awaiting"
  | "purchased"
  | "ready"
  | "given"
  | "skipped"

const STATUS_OF: Record<GiftStage, GiftCoverageStatus> = {
  planned: "planned",
  purchased: "awaiting",
  arrived: "purchased",
  ready: "ready",
  given: "given",
}

export interface GiftCoverage {
  occasionId: string
  recipientId: string
  status: GiftCoverageStatus
  /**
   * The owner said shopping is complete, or skipped them, or their target is met by gifts past
   * planning. With no target, only the owner's call marks them done: one purchase never does.
   */
  done: boolean
  /** Gifts on this occasion that include them. */
  gifts: number
  /** Of those, gifts bought (filled) or given. */
  bought: number
}

/**
 * How covered one roster row is, from the occasion's buckets (see `giftBuckets`), the row's
 * target and the owner's decision. `status` is the progress of the weakest gift among the best
 * `target ?? 1` gifts; fewer gifts than that is `needs-planning`. A skip, or a target of 0, is
 * `skipped` and done.
 */
export function giftCoverage(
  row: GiftOccasionRecipient,
  buckets: readonly GiftBucket[],
): GiftCoverage {
  const mine = buckets.filter(
    (b) => b.occasionId === row.occasionId && b.recipientIds.includes(row.recipientId),
  )
  const bought = mine.filter((b) => b.stage !== "planned").length
  const base = {
    occasionId: row.occasionId,
    recipientId: row.recipientId,
    gifts: mine.length,
    bought,
  }
  // A target of 0 is a decision to give nothing here, as a skip is.
  if (row.decision === "skipped" || row.target === 0) {
    return { ...base, status: "skipped", done: true }
  }
  const need = row.target ?? 1
  const best = mine.map((b) => STAGES.indexOf(b.stage)).sort((x, y) => y - x)
  const weakest = best[need - 1]
  const status = weakest === undefined ? "needs-planning" : STATUS_OF[STAGES[weakest] as GiftStage]
  const done = row.decision === "complete" || (row.target !== null && bought >= row.target)
  return { ...base, status, done }
}

/** One currency's money. Shared and household gifts count once, from their purchase line. */
export interface GiftSpend {
  currency: string
  /** Estimates of gifts allocated but not bought: planning, never spend. */
  plannedMinor: number
  /** Bought units at their price, plus tax and shipping, less discounts. */
  spentMinor: number
  /** Returned units' value at their unit price, less what was refunded (never below 0). */
  pendingRefundMinor: number
  refundedMinor: number
  /** Spent less refunded: each refund counts once. */
  netMinor: number
  /** Some line's tax, shipping or discount is not known yet. */
  incomplete: boolean
}

/**
 * A purchase line's total: units ordered and not cancelled at their price, plus tax and
 * shipping, less discount. Returned units stay in it until they are refunded.
 */
export function purchaseTotal(p: GiftPurchase): number {
  return (
    p.unitPriceMinor * boughtUnits(p) +
    (p.taxMinor ?? 0) +
    (p.shippingMinor ?? 0) -
    (p.discountMinor ?? 0)
  )
}

/**
 * Money per currency, never summed across currencies, in the order each currency first appears.
 * Archived purchases and allocations count nowhere.
 */
export function giftSpend(
  purchases: readonly GiftPurchase[],
  allocations: readonly GiftAllocation[],
  items: readonly GiftItem[],
): GiftSpend[] {
  const rows = new Map<string, GiftSpend>()
  const row = (currency: string): GiftSpend => {
    let r = rows.get(currency)
    if (r === undefined) {
      r = {
        currency,
        plannedMinor: 0,
        spentMinor: 0,
        pendingRefundMinor: 0,
        refundedMinor: 0,
        netMinor: 0,
        incomplete: false,
      }
      rows.set(currency, r)
    }
    return r
  }
  for (const p of purchases) {
    if (p.archived) continue
    const r = row(p.currency)
    r.spentMinor += purchaseTotal(p)
    r.refundedMinor += p.refundedMinor
    r.pendingRefundMinor += Math.max(0, p.unitPriceMinor * p.returned - p.refundedMinor)
    if (!p.totalComplete) r.incomplete = true
  }
  const byId = new Map(items.map((i) => [i.id, i]))
  for (const a of allocations) {
    if (a.archived || a.purchaseId !== null) continue
    const item = byId.get(a.itemId)
    if (item?.estimateMinor == null || item.currency === null) continue
    row(item.currency).plannedMinor += item.estimateMinor * allocationUnits(a)
  }
  for (const r of rows.values()) r.netMinor = r.spentMinor - r.refundedMinor
  return [...rows.values()]
}

/** Splits `total` into `weights.length` integer parts in proportion, summing exactly to it. */
export function splitMinor(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((n, w) => n + w, 0)
  if (sum === 0) return weights.map(() => 0)
  const exact = weights.map((w) => (total * w) / sum)
  const parts = exact.map(Math.floor)
  let left = total - parts.reduce((n, x) => n + x, 0)
  const order = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    parts[i] = (parts[i] ?? 0) + 1
    left -= 1
  }
  return parts
}

/** One recipient's share of a purchase line. A shared gift's share is split among its people. */
export interface GiftShare {
  allocationId: string
  recipientId: string
  minor: number
}

/**
 * A purchase line's total split over its units ordered and not cancelled (largest remainder, so
 * the parts sum to the line total exactly): first the units its buckets got, in fill order, then
 * the rest -- a stash, returned units, or units no allocation holds -- as `unallocatedMinor`.
 */
export function purchaseShares(
  purchase: GiftPurchase,
  buckets: readonly GiftBucket[],
  allocations: readonly GiftAllocation[],
): { shares: GiftShare[]; unallocatedMinor: number; totalMinor: number } {
  const own = new Set(allocations.filter((a) => a.purchaseId === purchase.id).map((a) => a.id))
  const mine = buckets.filter((b) => own.has(b.allocationId) && b.filled > 0)
  const totalMinor = purchaseTotal(purchase)
  const filled = mine.reduce((n, b) => n + b.filled, 0)
  const rest = Math.max(0, boughtUnits(purchase) - filled)
  if (filled + rest === 0) return { shares: [], unallocatedMinor: totalMinor, totalMinor }
  const parts = splitMinor(totalMinor, [...mine.map((b) => b.filled), rest])
  const shares: GiftShare[] = []
  mine.forEach((b, i) => {
    const each = splitMinor(
      parts[i] ?? 0,
      b.recipientIds.map(() => 1),
    )
    b.recipientIds.forEach((recipientId, j) => {
      shares.push({ allocationId: b.allocationId, recipientId, minor: each[j] ?? 0 })
    })
  })
  return { shares, unallocatedMinor: parts[mine.length] ?? 0, totalMinor }
}
