import type {
  GiftAllocation,
  GiftAllocationFields,
  GiftItem,
  GiftItemFields,
  GiftOccasion,
  GiftPurchase,
  GiftRecipient,
} from "./gift-model.js"
import { keptUnits } from "./gift-rules.js"

/**
 * Duplicate gift warnings (docket#100, design docket#92 "Status, coverage, and history rules").
 * Pure: the host reads the owner's records and asks before it writes an allocation, shows what
 * comes back, and writes anyway if the owner says yes, with the warned allocations in
 * `repeatOf`. A repeat gift can be meant, so no warning refuses a write.
 *
 * A warning is the same product -- the same item, or the same normalized product key, else the
 * same normalized web (http or https) URL, with the same variant -- already allocated to one of
 * the same people:
 * - on another live occasion, unless that gift's item is archived or rejected (a dropped idea);
 * - or in their history: given to them (archived or not), or bought for them on an archived
 *   occasion with units still kept (not all returned or cancelled, the purchase not archived).
 * An archived allocation that was never given was taken back and does not count; nor does
 * another gift on the same occasion. A possible duplicate is only offered: the same product in
 * another variant, the same page (another query, or another product key), or the same title.
 * Only allocations count: a watch or a scout having seen a listing is never taken as the person
 * owning it. People match by recipient id, and a household matches each of its members both ways.
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

/**
 * A web URL's shop page, without scheme, `www.` or `m.`, fragment or tracking parameters, and its
 * query. Null for anything that is not an http or https URL (`n/a`, a relative path, `mailto:`),
 * which never identifies a product.
 */
function urlParts(url: string | null): { page: string; query: string } | null {
  if (url === null || url.trim() === "") return null
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null
  const host = u.host.toLowerCase().replace(/^(www|m)\./, "")
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : ""
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith("utm_") && !TRACKING.has(k.toLowerCase()))
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
  return { page: `${host}${path}`, query: new URLSearchParams(params).toString() }
}

/**
 * A web URL normalized for comparing gifts: two links to one product page give the same key. Null
 * for anything that is not an http or https URL.
 */
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
  /** The new allocation's people it concerns: the same recipient, or a household and its member. */
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
  /** The owner's records, archived ones too. */
  items: readonly GiftItem[]
  allocations: readonly GiftAllocation[]
  occasions: readonly GiftOccasion[]
  purchases: readonly GiftPurchase[]
  recipients: readonly GiftRecipient[]
}

/**
 * The earlier allocations the given one may repeat, in the order `allocations` lists them. An
 * unknown `itemId` gives an empty report (`GiftLedger.giftDuplicates` refuses it as not found).
 */
export function findGiftDuplicates(input: GiftDuplicateInput): GiftDuplicateReport {
  const report: GiftDuplicateReport = { warnings: [], possible: [] }
  const mine = input.allocation
  const item = input.items.find((i) => i.id === mine.itemId)
  if (item === undefined) return report
  const accepted = new Set(mine.repeatOf ?? [])
  const households = input.recipients.filter((r) => r.kind === "household")
  /** The recipient ids that count as `id`: itself, its households, and a household's members. */
  const around = (id: string): string[] => [
    id,
    ...households.filter((h) => h.memberIds.includes(id)).map((h) => h.id),
    ...(households.find((h) => h.id === id)?.memberIds ?? []),
  ]
  for (const other of input.allocations) {
    if (other.id === mine.id) continue
    // An archived allocation was taken back, unless it was given: a gift given stays history.
    if (other.archived && other.handoff !== "given") continue
    const shared = mine.recipientIds.filter((r) =>
      around(r).some((x) => other.recipientIds.includes(x)),
    )
    if (shared.length === 0) continue
    const theirs = input.items.find((i) => i.id === other.itemId)
    if (theirs === undefined) continue
    const occasion = input.occasions.find((o) => o.id === other.occasionId)
    const closed = occasion === undefined || occasion.archived
    const purchase = input.purchases.find((p) => p.id === other.purchaseId)
    const kept = purchase !== undefined && !purchase.archived && keptUnits(purchase) > 0
    let where: GiftDuplicate["where"]
    if (other.handoff === "given" || (closed && kept)) where = "history"
    else if (
      !closed &&
      other.occasionId !== mine.occasionId &&
      !theirs.archived &&
      theirs.planning !== "rejected"
    ) {
      where = "open"
    } else continue
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
