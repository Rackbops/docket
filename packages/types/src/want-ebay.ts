import { clean } from "@rackbops/docket-core"
import { currencyCode, minorUnits, money } from "./money.js"
import { safeUrl } from "./research-answer.js"
import { matchesWords, searchWords, shopifyQuery } from "./want-shopify.js"
import {
  CONDITION_CHARS,
  checkSearchStatus,
  isEbayHost,
  isObj,
  type Listing,
  type ListingDetail,
  MAX_LISTINGS,
  SELLER_CHARS,
  type Source,
  SourceMiss,
  TITLE_CHARS,
} from "./want-sources.js"

/**
 * The eBay source (Rod, 2026-10-20, "Build it" on the eBay Browse API card): listings from eBay's
 * own Browse API, `GET /buy/browse/v1/item_summary/search` (developer.ebay.com, read 2026-10-20),
 * with an application token from the owner's eBay developer keyset. Using eBay's API under its API
 * License Agreement is eBay's own permission, where reading its pages is barred (User Agreement
 * s.3); the tracker still never opens an eBay page, and a judged eBay watch opens none either.
 *
 * A host registers the source only with eBay keys, and runs the request itself (`EbayBrowse`,
 * which adds api.ebay.com, the token and the marketplace header): this library opens nothing.
 *
 * One search a look, the newest `EBAY_LIMIT` listings, fixed-price and auction alike, narrowed by
 * the watch's top price (eBay's own `price` and `priceCurrency` filters). eBay matches the words
 * itself; a listing is still kept only when every word is in its title (`matchesWords`), as for
 * Shopify, so a description-only match is not DMed. An auction's price is its current bid, or its
 * Buy It Now price when it has one. The
 * seller line carries what eBay's answer shows: the seller's name, feedback percentage and score.
 *
 * The answer is untrusted text: every field is capped and cleaned, and an address is kept only as
 * an eBay item's own `https://<eBay host>/itm/<number>`.
 *
 * `detail` (0.20.0, Rod, 2026-10-30: "I have a developer API key now") reads one search result in
 * full through the same API, `GET /buy/browse/v1/item/{item_id}` (developer.ebay.com, getItem, read
 * 2026-10-30): its item specifics (`localizedAspects`), short description and description, as text
 * for the watch's `confirm` words, and its first shipping option's cost. Nothing of it is kept: the
 * watch uses it for the one run and the DM, as it does the search answer.
 */

export const EBAY_SEARCH_PATH = "/buy/browse/v1/item_summary/search"
/** getItem's path before the item id. */
export const EBAY_ITEM_PATH = "/buy/browse/v1/item/"
export const EBAY_MARKETPLACE = "EBAY_US"
export const EBAY_CURRENCY = "USD"
export const EBAY_LIMIT = 50
export const EBAY_ATTRIBUTION = "via eBay"

/** One Browse API call, a search or one item: the path, its query parameters, and the marketplace to send as `X-EBAY-C-MARKETPLACE-ID`. */
export interface EbayRequest {
  path: typeof EBAY_SEARCH_PATH | `${typeof EBAY_ITEM_PATH}${string}`
  params: Record<string, string>
  marketplace: typeof EBAY_MARKETPLACE
}

/** The host's run of one request on api.ebay.com with its application token: the HTTP status and the parsed JSON body (null when it was not JSON). */
export type EbayBrowse = (request: EbayRequest) => Promise<{ status: number; body: unknown }>

export interface EbaySearch {
  query: string
  maxPrice?: number
  currency?: string
}

/**
 * The request for a search: the words as sent (cut at a word, like Shopify's), newest first, at
 * most `EBAY_LIMIT`, and at or under the top price. eBay US prices in USD, so the price filter is
 * sent only for a watch in USD (or naming no valid currency, `currencyCode`); a watch in another
 * currency gets no filter here, and the want-list type never searches for one (`pollWant` answers
 * it with a miss the owner hears, docket#41). The filter is in whole units with decimals. Pure.
 */
export function ebayRequest(s: EbaySearch): EbayRequest {
  const currency = currencyCode(s.currency) ?? EBAY_CURRENCY
  const params: Record<string, string> = {
    q: shopifyQuery(s.query),
    limit: String(EBAY_LIMIT),
    sort: "newlyListed",
  }
  if (
    currency === EBAY_CURRENCY &&
    s.maxPrice !== undefined &&
    Number.isFinite(s.maxPrice) &&
    s.maxPrice >= 0
  ) {
    const digits = Math.round(Math.log10(minorUnits(currency)))
    params.filter = `price:[..${s.maxPrice.toFixed(digits)}],priceCurrency:${currency}`
  }
  return { path: EBAY_SEARCH_PATH, params, marketplace: EBAY_MARKETPLACE }
}

/** eBay's `{ value, currency }`, value a decimal string: as a number and a code; null without both. */
function amountOf(v: unknown): { value: number; currency: string } | null {
  if (!isObj(v)) return null
  const raw = typeof v.value === "string" || typeof v.value === "number" ? String(v.value) : ""
  const currency = typeof v.currency === "string" ? v.currency.trim().toUpperCase() : ""
  if (!/^[0-9]{1,12}(\.[0-9]{1,4})?$/.test(raw.trim()) || !/^[A-Z]{3}$/.test(currency)) return null
  return { value: Number(raw), currency }
}

/** An eBay item's own address, `https://<eBay host>/itm/<number>`, or null for anything else. */
function itemUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== "https:" || !isEbayHost(u.hostname)) return null
  const item = /^\/itm\/(?:[^/]+\/)?([0-9]{6,20})\/?$/.exec(u.pathname)
  return item ? safeUrl(`https://${u.hostname.toLowerCase()}/itm/${item[1]}`) : null
}

/** "name, 99.8% positive, 1234 feedback": what eBay shows of the seller, or "" with no name. */
function sellerOf(v: unknown): string {
  if (!isObj(v) || typeof v.username !== "string") return ""
  const name = clean(v.username, 40, true)
  if (!name) return ""
  const parts = [name]
  const pct = typeof v.feedbackPercentage === "string" ? v.feedbackPercentage.trim() : ""
  if (/^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(pct)) parts.push(`${pct}% positive`)
  if (typeof v.feedbackScore === "number" && Number.isInteger(v.feedbackScore))
    parts.push(`${v.feedbackScore} feedback`)
  return clean(parts.join(", "), SELLER_CHARS, true)
}

/**
 * The listings in one search answer: each item summary whose title holds every word of `query`,
 * with an eBay item address, priced (an auction at its current bid), with its condition, "auction"
 * when it is one, and its seller. At most `MAX_LISTINGS`. An answer with no `itemSummaries` is a
 * search with no results (eBay leaves the field out then); one that is not a search answer at all
 * throws `SourceMiss`. Pure.
 */
export function parseEbayAnswer(body: unknown, query: string): Listing[] {
  if (!isObj(body) || (body.itemSummaries === undefined && typeof body.total !== "number"))
    throw new SourceMiss("eBay's answer was not a search result")
  const items = Array.isArray(body.itemSummaries) ? body.itemSummaries : []
  const words = searchWords(query)
  const out: Listing[] = []
  const seen = new Set<string>()
  for (const item of items.slice(0, EBAY_LIMIT * 4)) {
    if (out.length >= MAX_LISTINGS) break
    if (!isObj(item) || typeof item.title !== "string" || typeof item.itemId !== "string") continue
    if (!matchesWords(item.title.slice(0, 2_000), words)) continue
    const title = clean(item.title, TITLE_CHARS, true)
    const url = itemUrl(item.itemWebUrl)
    if (!title || !url || item.itemId.length > 120) continue
    // Keyed by the listing's `/itm/<number>`, which its variations share: one listing is told once,
    // whichever variation eBay puts first on a later look.
    const number = /\/itm\/([0-9]+)$/.exec(url)?.[1]
    if (!number || seen.has(number)) continue
    seen.add(number)
    const options = Array.isArray(item.buyingOptions) ? item.buyingOptions : []
    const auction = options.includes("AUCTION")
    const buyNow = options.includes("FIXED_PRICE")
    // A plain auction at its current bid; one with Buy It Now at that price, which buys it outright.
    const price = amountOf(auction && !buyNow ? (item.currentBidPrice ?? item.price) : item.price)
    const state = typeof item.condition === "string" ? clean(item.condition, 30, true) : ""
    const kind = auction ? [buyNow ? "auction, Buy It Now" : "auction"] : []
    const condition = clean([state, ...kind].filter(Boolean).join(", "), CONDITION_CHARS, true)
    const seller = sellerOf(item.seller)
    const ref = EBAY_ITEM_ID.test(item.itemId) ? item.itemId : ""
    out.push({
      id: `ebay:${number}`,
      title,
      url,
      ...(ref ? { ref } : {}),
      ...(price ? { price: price.value, currency: price.currency } : {}),
      ...(condition ? { condition } : {}),
      ...(seller ? { seller } : {}),
    })
  }
  return out
}

/** eBay's RESTful item id, `v1|<listing number>|<variation, 0 for none>`. */
export const EBAY_ITEM_ID = /^v1\|[0-9]{6,20}\|[0-9]{1,20}$/

/** The longest text kept from one item read, and from its description alone. */
export const DETAIL_CHARS = 20_000
const DESCRIPTION_CHARS = 12_000

/** The getItem request for `ref` (an `EBAY_ITEM_ID`), or null for anything else. Pure. */
export function ebayItemRequest(ref: string): EbayRequest | null {
  if (!EBAY_ITEM_ID.test(ref)) return null
  return {
    path: `${EBAY_ITEM_PATH}${encodeURIComponent(ref)}`,
    params: {},
    marketplace: EBAY_MARKETPLACE,
  }
}

/** HTML as plain words: tags, scripts and styles out, entities a space. Bounded, no backtracking. */
function plain(html: string): string {
  return html
    .slice(0, DESCRIPTION_CHARS * 4)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z0-9#]{1,10};/gi, " ")
}

/** "$4.99 shipping" or "free shipping" from the first shipping option with a cost, or "". */
function shippingOf(options: unknown): string {
  if (!Array.isArray(options)) return ""
  for (const o of options.slice(0, 10)) {
    if (!isObj(o)) continue
    const cost = amountOf(o.shippingCost)
    if (!cost) continue
    return cost.value === 0 ? "free shipping" : `${money(cost.value, cost.currency)} shipping`
  }
  return ""
}

/**
 * What one getItem answer says, as `ListingDetail`: the title, short description, each item
 * specific as "name: value", the product's own title, and the description as plain text, cleaned
 * and capped at `DETAIL_CHARS`; and its shipping. Null for an answer that is not an item. Pure.
 */
export function parseEbayItem(body: unknown): ListingDetail | null {
  if (!isObj(body) || typeof body.itemId !== "string") return null
  const parts: string[] = []
  const text = (v: unknown, max: number) => (typeof v === "string" ? clean(v, max, true) : "")
  parts.push(text(body.title, TITLE_CHARS), text(body.shortDescription, 2_000))
  if (Array.isArray(body.localizedAspects)) {
    for (const a of body.localizedAspects.slice(0, 100)) {
      if (!isObj(a)) continue
      const name = text(a.name, 80)
      const value = text(a.value, 400)
      if (name || value) parts.push(`${name}: ${value}`)
    }
  }
  if (isObj(body.product)) parts.push(text(body.product.title, TITLE_CHARS))
  if (typeof body.description === "string") {
    parts.push(clean(plain(body.description), DESCRIPTION_CHARS, true))
  }
  const shipping = shippingOf(body.shippingOptions)
  return {
    text: clean(parts.filter(Boolean).join("\n"), DETAIL_CHARS, true),
    ...(shipping ? { shipping } : {}),
  }
}

/** The `ebay` source over the host's `browse`: `target` is the words to search for, `limits` the watch's top price and currency. */
export function ebaySource(browse: EbayBrowse): Source {
  return {
    id: "ebay",
    async search(target, _fetch, limits) {
      if (searchWords(target).length === 0) throw new SourceMiss("there are no words to search for")
      let status: number
      let body: unknown
      try {
        ;({ status, body } = await browse(ebayRequest({ query: target, ...limits })))
      } catch (err) {
        throw new SourceMiss(
          `eBay could not be searched: ${clean(err instanceof Error ? err.message : String(err), 200, true)}`,
          { cause: err },
        )
      }
      // Keys eBay refuses, or an app without Browse access: no later look succeeds until someone acts.
      checkSearchStatus(status, "eBay", "eBay refused the app's keys")
      return parseEbayAnswer(body, target)
    },
    async detail(listing) {
      const request = listing.ref ? ebayItemRequest(listing.ref) : null
      if (!request) return null
      try {
        const { status, body } = await browse(request)
        return status === 200 ? parseEbayItem(body) : null
      } catch {
        return null
      }
    },
  }
}
