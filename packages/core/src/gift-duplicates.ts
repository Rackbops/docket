import type {
  GiftAllocation,
  GiftAllocationFields,
  GiftItem,
  GiftItemFields,
  GiftOccasion,
} from "./gift-model.js"

/**
 * Duplicate gift warnings (docket#100, design docket#92 "Status, coverage, and history rules").
 * Pure: the host reads the owner's records and asks before it writes an allocation, shows what
 * comes back, and writes anyway if the owner says yes, with the warned allocations in
 * `repeatOf`. A repeat gift can be meant, so nothing here refuses a write.
 *
 * A warning is the same product (the same item, or the same normalized product key, else the
 * same normalized URL, with the same variant) already allocated to one of the same people on
 * another live occasion, or in their history: given to them (archived or not), or bought for them
 * on an archived occasion. An archived allocation that was never given was taken back and does
 * not count. A possible duplicate is only offered: the same product in another variant, the same
 * page with another query, or the same title. Only allocations count: a watch or a scout having
 * seen a listing is never taken as the person owning it. People are matched by recipient id: a
 * household and its members are different recipients.
 */

/** Query parameters that only track a click; they never tell two products apart. */
const TRACKING = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_",
  "srsltid",
])

const fold = (v: string | null): string | null => {
  if (v === null) return null
  const t = v.trim().replace(/\s+/g, " ").toLowerCase()
  return t === "" ? null : t
}

/** A URL's shop page, without scheme, `www.`, fragment or tracking parameters, and its query. */
function urlParts(url: string | null): { page: string; query: string } | null {
  if (url === null || url.trim() === "") return null
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    const t = fold(url)
    return t === null ? null : { page: t, query: "" }
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "")
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : ""
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith("utm_") && !TRACKING.has(k.toLowerCase()))
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
  return { page: `${host}${path}`, query: new URLSearchParams(params).toString() }
}

/** A URL normalized for comparing gifts: two links to one product page give the same key. */
export function giftUrlKey(url: string | null): string | null {
  const p = urlParts(url)
  if (p === null) return null
  return p.query === "" ? p.page : `${p.page}?${p.query}`
}

const titleKey = (title: string): string | null => fold(title.replace(/[^\p{L}\p{N}]+/gu, " "))

export type GiftDuplicateMatch = "item" | "productKey" | "url"
export type GiftPossibleMatch = "variant" | "page" | "title"

/**
 * How two items compare: `same` for one product, `possible` for a near match, null otherwise.
 * The product key decides when both items have one; otherwise the URL does.
 */
export function compareGiftItems(
  a: Pick<GiftItemFields, "title" | "url" | "productKey" | "variant"> & { id?: string },
  b: Pick<GiftItemFields, "title" | "url" | "productKey" | "variant"> & { id?: string },
): { same: GiftDuplicateMatch } | { possible: GiftPossibleMatch } | null {
  if (a.id !== undefined && a.id === b.id) return { same: "item" }
  const sameVariant = fold(a.variant) === fold(b.variant)
  const ka = fold(a.productKey)
  const kb = fold(b.productKey)
  const ua = urlParts(a.url)
  const ub = urlParts(b.url)
  if (ka !== null && kb !== null) {
    if (ka === kb) return sameVariant ? { same: "productKey" } : { possible: "variant" }
  } else if (ua !== null && ub !== null && giftUrlKey(a.url) === giftUrlKey(b.url)) {
    return sameVariant ? { same: "url" } : { possible: "variant" }
  }
  if (ua !== null && ub !== null && ua.page === ub.page) return { possible: "page" }
  const ta = titleKey(a.title)
  if (ta !== null && ta === titleKey(b.title)) return { possible: "title" }
  return null
}

/** One earlier allocation the new one may repeat. */
export interface GiftDuplicate {
  allocationId: string
  itemId: string
  occasionId: string
  /** The people the two allocations share. */
  recipientIds: string[]
  /** Where it sits: on another live occasion, or in the people's history. */
  where: "open" | "history"
  match: GiftDuplicateMatch | GiftPossibleMatch
  /** The owner already accepted it (the new allocation's `repeatOf` names it). */
  accepted: boolean
}

export interface GiftDuplicateReport {
  /** The same product: shown as a warning the owner can accept. */
  warnings: GiftDuplicate[]
  /** A near match: offered as "possible duplicate", never a warning. */
  possible: GiftDuplicate[]
}

export interface GiftDuplicateInput {
  /** The allocation about to be written; `id` when it is an edit of an existing one. */
  allocation: Pick<GiftAllocationFields, "itemId" | "occasionId" | "recipientIds"> & {
    id?: string
    repeatOf?: readonly string[] | null
  }
  /** The owner's items, allocations and occasions, archived ones too. */
  items: readonly GiftItem[]
  allocations: readonly GiftAllocation[]
  occasions: readonly GiftOccasion[]
}

/** The earlier allocations the given one may repeat, in the order `allocations` lists them. */
export function findGiftDuplicates(input: GiftDuplicateInput): GiftDuplicateReport {
  const report: GiftDuplicateReport = { warnings: [], possible: [] }
  const mine = input.allocation
  const item = input.items.find((i) => i.id === mine.itemId)
  if (item === undefined) return report
  const accepted = new Set(mine.repeatOf ?? [])
  for (const other of input.allocations) {
    if (other.id === mine.id) continue
    // An archived allocation was taken back, unless it was given: a gift given stays history.
    if (other.archived && other.handoff !== "given") continue
    const shared = other.recipientIds.filter((r) => mine.recipientIds.includes(r))
    if (shared.length === 0) continue
    const occasion = input.occasions.find((o) => o.id === other.occasionId)
    const closed = occasion === undefined || occasion.archived
    const given = other.handoff === "given"
    let where: GiftDuplicate["where"]
    if (given || (closed && other.purchaseId !== null)) where = "history"
    else if (!closed && other.occasionId !== mine.occasionId) where = "open"
    else continue
    const theirs = input.items.find((i) => i.id === other.itemId)
    if (theirs === undefined) continue
    const how = compareGiftItems(item, theirs)
    if (how === null) continue
    const found: GiftDuplicate = {
      allocationId: other.id,
      itemId: other.itemId,
      occasionId: other.occasionId,
      recipientIds: shared,
      where,
      match: "same" in how ? how.same : how.possible,
      accepted: accepted.has(other.id),
    }
    if ("same" in how) report.warnings.push(found)
    else report.possible.push(found)
  }
  return report
}
