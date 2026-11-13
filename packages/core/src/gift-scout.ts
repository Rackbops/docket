import type { GiftItemFields, GiftRecipientFields } from "./gift-model.js"
import { GIFT_NOTES_MAX, GIFT_TEXT_MAX } from "./gift-validate.js"
import type { StoredFinding, Task } from "./model.js"
import { clean } from "./text.js"

/**
 * Gifts and the scout (docket#101, design docket#92 "Capture, discovery, and notifications").
 * Pure: a host reads the finding or the watches from its task `Store`, and writes the gift
 * through `GiftLedger`. Nothing here reads or writes a task, so saving an idea or linking a watch
 * can never change one.
 *
 * - `giftIdeaFromFinding`: "save as gift idea". A finding becomes an item in the `idea` state,
 *   linked back by `source: { kind: "scout", ref: "<taskId>/<findingId>" }`. It is never
 *   selected, bought or allocated, so it covers nobody. The finding's text is kept only as the
 *   item's notes, as text: whatever it says, it is never read as an instruction.
 * - An eBay finding copies nothing of the listing. The eBay adapter keeps no listing data
 *   (`keepsFindings` is false for an eBay watch: eBay's API License limits how long listing data
 *   may be kept), so an eBay finding's text and address are not copied: the owner names the gift,
 *   and only the link back is kept.
 * - `giftWatchProblems`: a gift's `watchTaskIds` may name only the owner's own price or want-list
 *   watches.
 * - `giftScoutBrief`: what a scout run for a gift may be told about the person -- only the
 *   interests and avoidances the owner picks, never their name, the roster or purchase history.
 */

/** The task types a gift may link to as watches. */
export const GIFT_WATCH_TYPES: readonly string[] = ["price", "wantlist"]

/** eBay's hosts: `ebay.com`, `ebay.co.uk`, `www.ebay.de` and the like (as the eBay source's). */
const EBAY_HOST = /(^|\.)ebay\.[a-z]{2,3}(\.[a-z]{2})?$/i

/** A finding from eBay: tagged by the eBay source, or naming an eBay address. */
export function isEbayFinding(finding: Pick<StoredFinding, "tags" | "source">): boolean {
  if (finding.tags.includes("ebay")) return true
  if (finding.source === null) return false
  try {
    return EBAY_HOST.test(new URL(finding.source).hostname.replace(/\.$/, ""))
  } catch {
    return false
  }
}

/** An http or https address with no login in it, as given; null otherwise. */
function webUrl(value: string | null): string | null {
  if (value === null) return null
  const t = value.trim()
  if (t === "" || t.length > 2000) return null
  try {
    const u = new URL(t)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    if (u.username !== "" || u.password !== "") return null
    return t
  } catch {
    return null
  }
}

/** What the owner says when saving: a title (needed for an eBay finding), and a planning price. */
export interface GiftIdeaChoice {
  title?: string
  estimateMinor?: number | null
  currency?: string | null
}

/**
 * The item "save as gift idea" makes from one finding: planning `idea`, linked to the finding,
 * with the finding's first line as its title (or the owner's), its address as the URL and its
 * text as notes, cleaned and capped. An eBay finding gives no title, URL or notes: the owner's
 * title is needed (a missing one is left blank, which the ledger refuses). Write it with
 * `GiftLedger.create("item", ...)`.
 */
export function giftIdeaFromFinding(
  finding: Pick<StoredFinding, "id" | "taskId" | "text" | "tags" | "source">,
  choice: GiftIdeaChoice = {},
): GiftItemFields {
  const ebay = isEbayFinding(finding)
  const firstLine = finding.text.split("\n").find((l) => l.trim() !== "") ?? ""
  const title = choice.title ?? (ebay ? "" : firstLine)
  return {
    title: clean(title, GIFT_TEXT_MAX, true),
    url: ebay ? null : webUrl(finding.source),
    productKey: null,
    variant: null,
    notes: ebay ? null : clean(finding.text, GIFT_NOTES_MAX) || null,
    source: { kind: "scout", ref: `${finding.taskId}/${finding.id}` },
    planning: "idea",
    estimateMinor: choice.estimateMinor ?? null,
    currency: choice.currency ?? null,
  }
}

/**
 * Why a gift may not link to these watches: each must be one of `tasks` (the host's read of the
 * owner's tasks), owned by `ownerId`, of a watch type (`GIFT_WATCH_TYPES`). Empty when it may.
 * A missing task and another owner's read the same, so a guessed id reveals nothing.
 */
export function giftWatchProblems(
  ownerId: string,
  watchTaskIds: readonly string[],
  tasks: readonly Pick<Task, "id" | "ownerId" | "type">[],
): string[] {
  const problems: string[] = []
  for (const id of watchTaskIds) {
    const t = tasks.find((x) => x.id === id && x.ownerId === ownerId)
    if (t === undefined) problems.push(`no watch ${id}`)
    else if (!GIFT_WATCH_TYPES.includes(t.type)) {
      problems.push(`task ${id} is a ${t.type}, not a price or want-list watch`)
    }
  }
  return problems
}

/** What a scout run for a gift is told about the person. */
export interface GiftScoutBrief {
  interests: string[]
  avoid: string[]
}

/**
 * The interests and avoidances the owner picked, kept only where the recipient has them (as the
 * owner typed them): nothing else of the person -- no name, roster, occasion or purchase history
 * -- goes to a scout. Picks match folded (trimmed, spaced once, case-folded).
 */
export function giftScoutBrief(
  recipient: Pick<GiftRecipientFields, "interests" | "avoid">,
  picked: { interests?: readonly string[]; avoid?: readonly string[] },
): GiftScoutBrief {
  const fold = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase()
  const keep = (have: readonly string[], want: readonly string[] = []) => {
    const w = new Set(want.map(fold))
    return have.filter((x) => w.has(fold(x)))
  }
  return {
    interests: keep(recipient.interests, picked.interests),
    avoid: keep(recipient.avoid, picked.avoid),
  }
}
