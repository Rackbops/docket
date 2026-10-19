import { clean } from "@rackbops/docket-core"
import { safeUrl } from "./research-answer.js"
import {
  type Listing,
  MAX_LISTINGS,
  type SearchLimits,
  type Source,
  SourceMiss,
  SourceUnavailableError,
} from "./want-sources.js"

/**
 * The Shopify source (Rod, 2026-10-19: "add Shopify to watches, daily"): new copies in stock at
 * Shopify stores, from Shopify's catalog search as Firecrawl's Alexandria runs it -- provider
 * `shopify`, capability `catalog/search_catalog`, 5 Firecrawl credits a search (its contract, read
 * 2026-10-19). A host registers the source only with a Firecrawl key, and runs the request itself
 * (`ShopifyScrape`): this library opens nothing.
 *
 * One search a look, one page of at most `SHOPIFY_LIMIT` products, in stock only and under the top
 * price when one is set (Shopify's own `filters`, in minor units). Shopify's search is loose -- it
 * returns related products too -- so a product is kept only when every word of the watch's search
 * is in its title (`matchesWords`). Only a variant that is available, and new or unmarked, is a
 * listing: the catalog sells new copies, and a used one is not what this source is for. The
 * country filter is Shopify's, and leaky (stores abroad still appear, priced in the asked currency).
 *
 * The answer is untrusted shop text: every field is capped and cleaned, an address is kept only as
 * an absolute http(s) one without Shopify's per-view parameters, and the walk is bounded.
 */

export const SHOPIFY_PROVIDER = "shopify"
export const SHOPIFY_CAPABILITY = "catalog/search_catalog"
/** Firecrawl's listed price for one search (its contract, 2026-10-19). */
export const SHOPIFY_CREDITS = 5
export const SHOPIFY_LIMIT = 50
export const SHOPIFY_COUNTRY = "US"
export const SHOPIFY_CURRENCY = "USD"
export const SHOPIFY_ATTRIBUTION = "via Shopify"
const MAX_VARIANTS = 20
const TITLE_CHARS = 150
const SELLER_CHARS = 80

/** The Alexandria call for one look: `{ provider, capability, options }`, sent as the `alexandria` field of Firecrawl's `POST /v2/scrape`. */
export interface ShopifyRequest {
  provider: typeof SHOPIFY_PROVIDER
  capability: typeof SHOPIFY_CAPABILITY
  options: {
    query: string
    country: string
    currency: string
    limit: number
    filters: { available: true; price?: { max: number } }
  }
}

/** The host's run of one request: Firecrawl's HTTP status and its parsed JSON body (null when it was not JSON). */
export type ShopifyScrape = (request: ShopifyRequest) => Promise<{ status: number; body: unknown }>

export interface ShopifySearch extends SearchLimits {
  query: string
}

/** The request for a search: in stock, at or under the top price (minor units, rounded down), in USD unless the watch names a currency. Pure. */
export function shopifyRequest(s: ShopifySearch): ShopifyRequest {
  const filters: ShopifyRequest["options"]["filters"] = { available: true }
  if (s.maxPrice !== undefined) filters.price = { max: Math.floor(s.maxPrice * 100 + 1e-6) }
  return {
    provider: SHOPIFY_PROVIDER,
    capability: SHOPIFY_CAPABILITY,
    options: {
      query: clean(s.query, 200, true),
      country: SHOPIFY_COUNTRY,
      currency: s.currency ?? SHOPIFY_CURRENCY,
      limit: SHOPIFY_LIMIT,
      filters,
    },
  }
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** The words a title must hold: letters and digits, lower-cased, in any order. */
export function searchWords(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
}

/** Whether `title` holds every one of `words` as a whole word. Pure. */
export function matchesWords(title: string, words: readonly string[]): boolean {
  const have = new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  return words.every((w) => have.has(w))
}

/** A variant's address without Shopify's per-search parameters (`_gsid`, the `utm_*` family), keeping `variant`. */
function listingUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  u.hash = ""
  for (const key of [...u.searchParams.keys()]) if (key !== "variant") u.searchParams.delete(key)
  return safeUrl(u.toString())
}

/** A price object `{ amount, currency }` in minor units, as a value and a code; null without both. */
function priceOf(v: unknown): { value: number; currency: string } | null {
  if (!isObj(v)) return null
  const amount = v.amount
  const currency = typeof v.currency === "string" ? v.currency.trim().toUpperCase() : ""
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null
  if (!/^[A-Z]{3}$/.test(currency)) return null
  return { value: Math.round(amount) / 100, currency }
}

function isNew(variant: Json): boolean {
  const c = variant.condition
  if (c === undefined) return true
  const all = (Array.isArray(c) ? c : [c]).filter((x): x is string => typeof x === "string")
  return all.length === 0 || all.some((x) => x.toLowerCase() === "new")
}

/**
 * The listings in one search answer (Firecrawl's body): each product whose title holds every word
 * of `query`, and in it each variant that is available, new or unmarked, with an address -- titled
 * by the product (and the variant, when it names one of its own), priced, and sold by its store. At
 * most `MAX_LISTINGS`. Throws `SourceMiss` when the answer is not a search result. Pure.
 */
export function parseShopifyAnswer(body: unknown, query: string): Listing[] {
  const result = isObj(body) && isObj(body.data) ? body.data.alexandria : undefined
  const first = Array.isArray(result) ? result[0] : undefined
  if (!isObj(first)) throw new SourceMiss("Firecrawl's answer had no search result")
  if (first.error !== undefined && first.error !== null) {
    const e = first.error
    const why = isObj(e) && typeof e.code === "string" ? clean(e.code, 60, true) : "an error"
    throw new SourceMiss(`Shopify's search failed (${why})`)
  }
  const data = first.data
  if (!isObj(data) || !Array.isArray(data.products))
    throw new SourceMiss("Shopify's search answer had no products")
  const words = searchWords(query)
  const out: Listing[] = []
  const seen = new Set<string>()
  for (const product of data.products.slice(0, SHOPIFY_LIMIT)) {
    if (out.length >= MAX_LISTINGS) break
    if (!isObj(product) || typeof product.title !== "string") continue
    const title = clean(product.title, TITLE_CHARS, true)
    if (!title || !matchesWords(title, words)) continue
    const variants = Array.isArray(product.variants) ? product.variants.slice(0, MAX_VARIANTS) : []
    for (const v of variants) {
      if (out.length >= MAX_LISTINGS) break
      if (!isObj(v) || typeof v.id !== "string" || !isNew(v)) continue
      if (!isObj(v.availability) || v.availability.available !== true) continue
      const url = listingUrl(v.url)
      const id = `shopify:${clean(v.id, 120, true)}`
      if (!url || seen.has(id)) continue
      seen.add(id)
      const own = typeof v.title === "string" ? clean(v.title, TITLE_CHARS, true) : ""
      // A variant named for itself ("Deluxe") says which one; Shopify's "Default Title" or a repeat of the product's says nothing.
      const named =
        own !== "" &&
        own.toLowerCase() !== "default title" &&
        !title.toLowerCase().includes(own.toLowerCase())
      const name = named ? clean(`${title} (${own})`, TITLE_CHARS, true) : title
      const price = priceOf(v.price)
      const seller = isObj(v.seller) && typeof v.seller.name === "string" ? v.seller.name : ""
      const sold = clean(seller, SELLER_CHARS, true)
      out.push({
        id,
        title: name,
        url,
        ...(price ? { price: price.value, currency: price.currency } : {}),
        condition: "new",
        ...(sold ? { seller: sold } : {}),
      })
    }
  }
  return out
}

/** The `shopify` source over the host's `scrape`: `target` is the words to search for, `limits` the watch's top price and currency. */
export function shopifySource(scrape: ShopifyScrape): Source {
  return {
    id: "shopify",
    async search(target, _fetch, limits) {
      if (searchWords(target).length === 0) throw new SourceMiss("there are no words to search for")
      let status: number
      let body: unknown
      try {
        ;({ status, body } = await scrape(shopifyRequest({ query: target, ...limits })))
      } catch (err) {
        throw new SourceMiss(
          `Shopify could not be searched: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      // A bad key, or no credits left: no later look succeeds until someone acts.
      if (status === 401 || status === 402 || status === 403)
        throw new SourceUnavailableError(
          status === 402 ? "the Firecrawl account is out of credits" : "Firecrawl refused the key",
        )
      if (status === 429 || status >= 500)
        throw new SourceMiss(`Firecrawl is busy (HTTP ${status})`)
      if (status !== 200) throw new SourceMiss(`Firecrawl answered HTTP ${status}`)
      return parseShopifyAnswer(body, target)
    },
  }
}
