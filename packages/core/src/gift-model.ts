/**
 * The gift organizer's records (plan item 158, epic Rackbops/docket#94, design docket#92). An
 * owner's private gift ledger beside the task types: who they are buying for, what they are
 * considering, what they bought, what it cost. It is not a task type and never runs on the
 * scheduler; it shares no row, id or name with the tracker's `Store` records.
 *
 * Money is an integer count of minor units (cents) with an ISO 4217 code beside it, never a
 * float; totals are kept per currency, never summed across them (`giftSpend`).
 * Gift budgets are spending plans; they have nothing to do with the model-call budgets in
 * `budget.ts`.
 */

/** Every gift record carries these. `revision` is 1 on create and moves by one on each update. */
export interface GiftBase {
  id: string
  ownerId: string
  revision: number
  /** Archived rows keep their history and stay readable; lists skip them unless asked. */
  archived: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Someone the owner buys for. Not a tracker `User`: no login, Discord id, notification or task
 * access comes with it. Labels, interests and avoidances are the owner's own words, never
 * inferred from a name.
 */
export interface GiftRecipientFields {
  displayName: string
  /** A household is one gift unit whose `memberIds` are person recipients. */
  kind: "person" | "household"
  memberIds: string[]
  labels: string[]
  interests: string[]
  avoid: string[]
  notes: string | null
}

/**
 * A saved rule over the owner's own labels (docket#98): a recipient matches when every label here
 * is one they carry, compared trimmed, spaced once and case-folded. Only labels the owner typed count: nothing
 * is inferred from a name, and a blank or unknown label never matches.
 */
export interface GiftGroupFilter {
  labels: string[]
}

/**
 * A named, reusable set of recipients: a static list (`memberIds`), or, with `filter`, the owner's
 * live recipients the filter matches now (`memberIds` then stays empty). Resolve a filter group
 * with `groupMembers`/`resolveGroups` and show the result before using it; an occasion snapshots
 * the result like a static group's list. `filter` may be left out (a group from before docket#98),
 * which is the same as null.
 */
export interface GiftGroupFields {
  name: string
  memberIds: string[]
  filter?: GiftGroupFilter | null
}

export type GiftOccasionKind = "christmas" | "birthday" | "anniversary" | "custom"

/** One occurrence of an occasion: Christmas 2026 and Christmas 2027 are two rows. */
export interface GiftOccasionFields {
  kind: GiftOccasionKind
  title: string
  /** Local date `YYYY-MM-DD`, when it has one. */
  date: string | null
  /** IANA zone the date is read in, when it matters. */
  timeZone: string | null
  year: number | null
  currency: string
  budgetMinor: number | null
  /**
   * Where the roster came from (docket#97): the groups chosen, then recipients added or left out
   * by hand. The roster rows are the snapshot; editing a group later changes them only through a
   * reviewed sync (`previewGroupSync`).
   */
  groupIds: string[]
  includeIds: string[]
  excludeIds: string[]
}

export type GiftCoverageDecision = "planning" | "complete" | "skipped"

/** A recipient on an occasion's roster. One row per (occasionId, recipientId). */
export interface GiftOccasionRecipientFields {
  occasionId: string
  recipientId: string
  /** How many gifts the owner means to give this person here, when they set one. */
  target: number | null
  budgetMinor: number | null
  /** The owner's explicit call: still planning, shopping complete, or skipped on purpose. */
  decision: GiftCoverageDecision
  skipReason: string | null
}

export type GiftPlanning = "idea" | "shortlisted" | "selected" | "rejected"

export interface GiftSourceRef {
  kind: "manual" | "scout" | "import"
  /** For a scout, `<taskId>/<findingId>`; for an import, its row's provenance. */
  ref: string | null
}

/** A gift being considered or bought. It may be assigned to nobody yet (a stash). */
export interface GiftItemFields {
  title: string
  url: string | null
  /** A normalized product identity when known (for duplicate checks, docket#100). */
  productKey: string | null
  variant: string | null
  notes: string | null
  source: GiftSourceRef
  planning: GiftPlanning
  /** A planning price, never spend. */
  estimateMinor: number | null
  currency: string | null
  /**
   * The owner's price or want-list watches this gift follows (docket#101), by task id. A link
   * only: linking, buying or archiving the gift never creates, pauses, edits or cancels a watch,
   * and what a watch observed (price, stock) stays in the watch, never in a purchase line. The
   * gift store cannot see tasks, so only the ids' shape is checked on a write: set it with
   * `GiftLedger.linkGiftWatches`, or check with `giftWatchProblems` first. Empty, null or left out
   * (an item from before docket#101) all mean none.
   */
  watchTaskIds?: string[] | null
}

/**
 * One purchase line: what was actually paid for an item. Quantities move independently (an
 * order is not a receipt; a return reopens a gap). Paid price is kept apart from any price a
 * watch observed.
 */
export interface GiftPurchaseFields {
  itemId: string
  merchant: string | null
  currency: string
  unitPriceMinor: number
  ordered: number
  received: number
  cancelled: number
  returned: number
  taxMinor: number | null
  shippingMinor: number | null
  discountMinor: number | null
  /**
   * True only when tax, shipping and discount are all known (0 when there is none); otherwise the
   * line's total is shown as incomplete.
   */
  totalComplete: boolean
  refundedMinor: number
  /** Local date `YYYY-MM-DD`. */
  purchasedOn: string | null
  reference: string | null
}

export type GiftHandoff = "none" | "wrapped" | "ready" | "given"

/**
 * Units of an item meant for an occasion and its recipients. `shared` means one gift for all of
 * `recipientIds` (a couple, a household), counted and charged once; otherwise each recipient
 * gets their own units. Handoff is independent of the purchase's acquisition state.
 */
export interface GiftAllocationFields {
  itemId: string
  occasionId: string
  recipientIds: string[]
  quantity: number
  shared: boolean
  purchaseId: string | null
  handoff: GiftHandoff
  /** Local date `YYYY-MM-DD`. */
  givenOn: string | null
  /**
   * The allocations this one knowingly repeats: duplicate warnings (`findGiftDuplicates`,
   * docket#100) the owner saw and accepted, or the idea a rollover carried it from. A warning is
   * never a refusal; this records the owner's yes, as an audit trail: each id must be another of
   * the owner's allocations, but nothing checks that it shares a person or product. Empty, null or
   * left out (an allocation from before docket#100) all mean none.
   */
  repeatOf?: string[] | null
}

export interface GiftFieldsByKind {
  recipient: GiftRecipientFields
  group: GiftGroupFields
  occasion: GiftOccasionFields
  occasionRecipient: GiftOccasionRecipientFields
  item: GiftItemFields
  purchase: GiftPurchaseFields
  allocation: GiftAllocationFields
}

export type GiftKind = keyof GiftFieldsByKind

export const GIFT_KINDS: readonly GiftKind[] = [
  "recipient",
  "group",
  "occasion",
  "occasionRecipient",
  "item",
  "purchase",
  "allocation",
]

/** A stored gift record of one kind. */
export type GiftRecord<K extends GiftKind> = GiftBase & GiftFieldsByKind[K]

export type GiftRecipient = GiftRecord<"recipient">
export type GiftGroup = GiftRecord<"group">
export type GiftOccasion = GiftRecord<"occasion">
export type GiftOccasionRecipient = GiftRecord<"occasionRecipient">
export type GiftItem = GiftRecord<"item">
export type GiftPurchase = GiftRecord<"purchase">
export type GiftAllocation = GiftRecord<"allocation">

/** Where a write came from, for the change history. */
export type GiftWriteSource = "web" | "discord" | "api" | "mcp" | "import" | "system"

/** One change to one record: who, when, from where, and the state before and after. */
export interface GiftEvent {
  id: string
  ownerId: string
  kind: GiftKind
  entityId: string
  /** The acting tracker user id, or a service name for `system`. */
  actor: string
  source: GiftWriteSource
  at: string
  /** Null on create. */
  prior: GiftBase | null
  next: GiftBase
}
