import { createHash } from "node:crypto"
import { clean, type Fetch } from "@rackbops/docket-core"
import { jsonLdBlocks, parsePrice, priceFromJson } from "./extract.js"
import { safeUrl } from "./research-answer.js"

/**
 * The want-list watcher's sources (category 2, plan 1.2 row 2; rackbops-bot-plugins#83): where a
 * wanted thing's listings come from, behind one port so the type (wantlist.ts) knows none of
 * them. Two read listings:
 *
 * - `page` (here): a listing or search page the owner pasted (roshne, 2026-10-04, "Pages too"), read
 *   through the fenced Fetch port as `/price` reads a product page, and only its structured data --
 *   JSON-LD `ItemList`s of products and standalone `Product`s. No guessing at HTML: a page without
 *   them yields nothing, and the owner is told.
 * - `bgg` (want-bgg.ts): BoardGameGeek's marketplace, through its XML API, off until BGG approves
 *   roshne's application and `TRACKER_BGG_TOKEN` is set.
 *
 * - `inbox` (here): listings sent in for the watch rather than read by the tracker -- an alert email
 *   a site sent the owner and they forwarded, or listings the owner's own browser found while they
 *   ran it (`inboxSource`). The host keeps each watch's inbox (its `target` is the inbox's key) and
 *   hands back what arrived; every field is untrusted and cleaned here (`submittedListing`).
 *
 * eBay is a third answer, not a source: the tracker never reads eBay (no API, no pages); `/want`
 * hands the owner an eBay search to save on eBay, whose own alerts do the watching (the tracker plugin's `/want`).
 */

export interface Listing {
  /** Stable for one listing: its URL without the fragment, for `page`; `bgg:<link>` for BGG. */
  id: string
  title: string
  url: string
  price?: number
  currency?: string
  condition?: string
  seller?: string
}

export type SourceId = "page" | "bgg" | "inbox"
export const SOURCE_IDS: readonly SourceId[] = ["page", "bgg", "inbox"]

export interface Source {
  id: SourceId
  /** The listings at `target` now; throws `SourceMiss` for a read that counts as a miss. */
  search(target: string, fetch: Fetch | undefined): Promise<Listing[]>
}

/** A read that found nothing usable (an error page, no structured data, a busy API): the type counts it. */
export class SourceMiss extends Error {
  override name = "SourceMiss"
}

/** The source cannot be read at all as set up (BGG refusing the token): a miss the owner should hear about. */
export class SourceUnavailableError extends SourceMiss {
  override name = "SourceUnavailableError"
}

export const MAX_LISTINGS = 100
const TITLE_CHARS = 150
const CONDITION_CHARS = 40
const SELLER_CHARS = 80
const MAX_DEPTH = 8

/** The key a listing is remembered by: a digest of its id, so the state stays small whatever the URLs. */
export function listingKey(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 32)
}

/**
 * A request header that is a directive to the host's Fetch port, never sent: any hop to eBay is
 * refused. The page source's reads carry it, so a pasted page that redirects to eBay is not read
 * either (roshne's rule: eBay's own saved-search alerts cover eBay; the tracker never reads it).
 * A host's Fetch adapter must honour it and strip it.
 */
export const NEVER_EBAY = "x-tracker-never-ebay"

/** eBay's own hosts (and its short links). */
export function isEbayHost(host: string): boolean {
  return /(^|\.)ebay\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(host.replace(/\.$/, ""))
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

function typesOf(node: Json): string[] {
  const t = node["@type"]
  const all = Array.isArray(t) ? t : [t]
  return all
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/^https?:\/\/schema\.org\//, ""))
}

const PRODUCT_TYPES = new Set([
  "Product",
  "IndividualProduct",
  "ProductModel",
  "ProductGroup",
  "Book",
  "Game",
  "VideoGame",
  "Vehicle",
])

function text(v: unknown, max: number): string {
  if (typeof v === "string") return clean(v, max, true)
  if (isObj(v) && typeof v.name === "string") return clean(v.name, max, true)
  return ""
}

/** schema.org's condition as a word: `https://schema.org/UsedCondition` is "used". */
function conditionOf(v: unknown): string {
  const raw = text(v, 200)
  const m = /(New|Used|Refurbished|Damaged)Condition$/i.exec(raw)
  return m ? (m[1] ?? "").toLowerCase() : clean(raw, CONDITION_CHARS, true)
}

function firstOffer(offers: unknown): Json | null {
  if (Array.isArray(offers)) return offers.find(isObj) ?? null
  return isObj(offers) ? offers : null
}

/**
 * Query parameters a shop adds per view or per search (Shopify's `_pos`/`_sid`/`_ss`, Google's
 * `srsltid`, the `utm_*` family and the click ids): dropped from a listing's address, so one listing
 * keeps one id from poll to poll and is not sent again as new.
 */
const PER_VIEW =
  /^(utm_[a-z]+|_pos|_sid|_ss|_psq|srsltid|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|pf_rd_[a-z]+|pd_rd_[a-z]+)$/i

function absolute(raw: unknown, base: string): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null
  try {
    const u = new URL(raw.trim(), base)
    u.hash = ""
    for (const key of [...u.searchParams.keys()]) if (PER_VIEW.test(key)) u.searchParams.delete(key)
    return safeUrl(u.toString())
  } catch {
    return null
  }
}

/** One listing from a product node, or null without a name or a usable address. */
function listingOf(node: Json, base: string, fallbackUrl: unknown): Listing | null {
  const title = text(node.name, TITLE_CHARS)
  const offer = firstOffer(node.offers)
  const url = absolute(node.url, base) ?? absolute(fallbackUrl, base) ?? absolute(offer?.url, base)
  if (!title || !url) return null
  const price = priceFromJson(node.offers ?? null)
  const condition = conditionOf(offer?.itemCondition ?? node.itemCondition)
  const seller = text(offer?.seller, SELLER_CHARS)
  return {
    id: url,
    title,
    url,
    ...(price ? { price: price.value } : {}),
    ...(price?.currency ? { currency: price.currency } : {}),
    ...(condition ? { condition } : {}),
    ...(seller ? { seller } : {}),
  }
}

/**
 * The listings in a page's JSON-LD: each `ItemList`'s elements (a `ListItem`'s `item`, or the
 * element itself) and each standalone product, in page order, without repeats. A product with no
 * address of its own is the page itself (a product page). Pure.
 */
export function listingsFromJsonLd(html: string, pageUrl: string): Listing[] {
  return readListings(html, pageUrl).listings
}

/** `listingsFromJsonLd`, and how many `ItemList`s the page declares: an empty one is a search with no results, not an unreadable page. */
export function readListings(
  html: string,
  pageUrl: string,
): { listings: Listing[]; lists: number } {
  let lists = 0
  const out: Listing[] = []
  const seen = new Set<string>()
  const add = (l: Listing | null) => {
    if (!l || seen.has(l.id) || out.length >= MAX_LISTINGS) return
    seen.add(l.id)
    out.push(l)
  }
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_LISTINGS) return
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1)
      return
    }
    if (!isObj(node)) return
    const types = typesOf(node)
    if (types.includes("ItemList")) {
      lists++
      const elements = Array.isArray(node.itemListElement)
        ? node.itemListElement
        : [node.itemListElement]
      for (const el of elements) {
        if (!isObj(el)) continue
        const item = isObj(el.item) ? el.item : el
        if (typesOf(item).includes("ItemList")) walk(item, depth + 1)
        else
          add(
            listingOf(item, pageUrl, el.url ?? (typeof el.item === "string" ? el.item : undefined)),
          )
      }
    } else if (types.some((t) => PRODUCT_TYPES.has(t))) {
      add(listingOf(node, pageUrl, pageUrl))
    }
    if (node["@graph"] !== undefined) walk(node["@graph"], depth + 1)
    if (isObj(node.mainEntity)) walk(node.mainEntity, depth + 1)
  }
  for (const block of jsonLdBlocks(html)) walk(block, 0)
  return { listings: out, lists }
}

/** The `page` source: the owner's page through the fenced Fetch port, structured data only. */
export const pageSource: Source = {
  id: "page",
  async search(target, fetch) {
    if (!fetch) throw new SourceMiss("this bot reads no pages")
    let body: string
    try {
      const response = await fetch.get(target, { [NEVER_EBAY]: "1" })
      if (response.status !== 200) throw new SourceMiss(`HTTP ${response.status}`)
      body = response.body
    } catch (err) {
      if (err instanceof SourceMiss) throw err
      // The cause is kept: `/want`'s first read tells a refused page from one that failed this once.
      throw new SourceMiss(`the read failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
    const { listings, lists } = readListings(body, target)
    // A search with nothing for sale (the usual state of a want) still declares its list.
    if (listings.length === 0 && lists === 0)
      throw new SourceMiss("no listings in the page's structured data")
    return listings
  },
}

const nonNegative = (n: number | null): number | undefined =>
  n !== null && Number.isFinite(n) && n >= 0 ? n : undefined

/**
 * An eBay item's address as `https://<its eBay site>/itm/<number>`: eBay's alert emails put a
 * different set of tracking parameters on every link (`_trksid`, `mkevt`, `euid`, ...), so the
 * one item would otherwise get a new id in every email. Any other address is kept as it is.
 */
function ebayItem(url: string | null): string | null {
  if (url === null) return null
  const u = new URL(url)
  const item = /^\/itm\/(?:[^/]+\/)?(\d{6,20})\/?$/.exec(u.pathname)
  return isEbayHost(u.hostname) && item ? `https://${u.hostname}/itm/${item[1]}` : url
}

/** What a host stores for one listing sent in: every field as it came, untrusted. */
export interface Submitted {
  title?: unknown
  url?: unknown
  price?: unknown
  currency?: unknown
  condition?: unknown
  seller?: unknown
}

/**
 * One sent-in listing as a `Listing`, or null without a title or an absolute http(s) address:
 * capped, cleaned to one line, the address without its fragment or per-view parameters, and an
 * eBay item's as its bare `/itm/<number>` (so one listing keeps one id), a price only when it is a finite number at or above zero, a currency only as
 * three letters. Pure.
 */
export function submittedListing(raw: Submitted): Listing | null {
  const title = typeof raw.title === "string" ? clean(raw.title, TITLE_CHARS, true) : ""
  // Absolute only: a relative or protocol-relative address names no site of its own.
  if (typeof raw.url !== "string" || !/^https?:\/\/[^/\\]/i.test(raw.url.trim())) return null
  const url = ebayItem(absolute(raw.url, "https://invalid.example/"))
  if (!title || !url || url.startsWith("https://invalid.example/")) return null
  const price =
    typeof raw.price === "number" && Number.isFinite(raw.price) && raw.price >= 0
      ? raw.price
      : typeof raw.price === "string"
        ? nonNegative(parsePrice(raw.price))
        : undefined
  const currency =
    typeof raw.currency === "string" && /^[A-Za-z]{3}$/.test(raw.currency.trim())
      ? raw.currency.trim().toUpperCase()
      : undefined
  const condition =
    typeof raw.condition === "string" ? clean(raw.condition, CONDITION_CHARS, true) : ""
  const seller = typeof raw.seller === "string" ? clean(raw.seller, SELLER_CHARS, true) : ""
  return {
    id: url,
    title,
    url,
    ...(price !== undefined ? { price } : {}),
    ...(currency ? { currency } : {}),
    ...(condition ? { condition } : {}),
    ...(seller ? { seller } : {}),
  }
}

/** The host's inbox: what has arrived for the watch whose inbox key is `key`, newest last. */
export type ReadInbox = (key: string) => Promise<readonly Submitted[]>

/**
 * The `inbox` source over a host's `read`: each run hands back the inbox's listings, cleaned and
 * without repeats (a listing sent in again counts as sent now, with its newest details), the
 * newest `MAX_LISTINGS`; the type's own memory of what it told keeps a listing from going out
 * twice. More than `MAX_LISTINGS` arriving between two runs loses the oldest of them, so a host
 * polls an inbox watch often. A host's read error is not passed on: the owner hears only that the
 * inbox could not be read. An empty inbox is no miss: nothing came in.
 */
export function inboxSource(read: ReadInbox): Source {
  return {
    id: "inbox",
    async search(target) {
      let items: readonly Submitted[]
      try {
        items = await read(target)
      } catch (err) {
        throw new SourceMiss("the inbox could not be read", { cause: err })
      }
      // A repeat moves to where it came in last, carrying its newest details.
      const byId = new Map<string, Listing>()
      for (const raw of items) {
        const l = submittedListing(raw)
        if (!l) continue
        byId.delete(l.id)
        byId.set(l.id, l)
      }
      // The newest are the ones worth keeping when more came in than one run takes.
      return [...byId.values()].slice(-MAX_LISTINGS)
    },
  }
}
