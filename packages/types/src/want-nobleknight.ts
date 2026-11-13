import { clean, type Fetch } from "@rackbops/docket-core"
import { parsePrice } from "./extract.js"
import {
  CONDITION_CHARS,
  checkSearchStatus,
  type Listing,
  NEVER_EBAY,
  type Source,
  SourceMiss,
  TITLE_CHARS,
} from "./want-sources.js"

/**
 * The `nobleknight` source (Rod, 2026-11-13: "make sure that https://www.nobleknight.com/ is a
 * trusted seller and is included in board game want tasks"): the copies in stock on one Noble Knight
 * Games product page. Noble Knight is not a Shopify store and its search and catalog pages are
 * closed to bots by its robots.txt, so a watch names the product page (`/P/<id>`, which robots.txt
 * leaves open) and each look reads that one page through the host's fenced Fetch port.
 *
 * The page lists each copy it has as its own row, with its grade ("VG+/NM", "SW (MINT/New)"), a
 * note ("unpunched, cards sealed") and its price; a copy is one listing, keyed by its inventory id,
 * so a new copy, or a copy back in stock under a new id, is new to the watch. The page's JSON-LD
 * names one offer only, at the list price, so the rows are read from the page's own markup: a row
 * is a `condition-col in_stock` block, its price and grade in its quantity box's label
 * ("Edit quantity Condition VG+/NM Price $495.00"), its inventory id in the Add to Cart button
 * (`<product id>#<inventory id>`). A page without the product's heading (`ppn_<id>`) is not the
 * product page and counts as a miss; one with the heading and no row in stock has nothing for sale.
 *
 * Noble Knight is trusted (Rod, same day): its listings name it as the seller and no shop check runs
 * (that is for Shopify stores only, shop-vet.ts).
 */

export const NOBLE_KNIGHT = "Noble Knight Games"
const HOST = /^(?:[a-z]{2,3}\.|www\.)?nobleknight\.com$/i
const PRODUCT_PATH = /^\/P\/(\d{6,12})(?:\/[^/?#]*)?\/?$/i
/** The most copies kept from one page. */
export const NOBLE_KNIGHT_MAX_COPIES = 50
const NOTE_CHARS = 80

/**
 * A Noble Knight product page's address in its one form, `https://www.nobleknight.com/P/<id>`, from
 * any of its forms (a regional host, the name in the path, a trailing slash, query parameters), or
 * null for any other address. Pure.
 */
export function nobleKnightProduct(raw: string): { id: string; url: string } | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  if (u.username !== "" || u.password !== "" || u.port !== "") return null
  if (!HOST.test(u.hostname)) return null
  const m = PRODUCT_PATH.exec(u.pathname)
  if (!m?.[1]) return null
  return { id: m[1], url: `https://www.nobleknight.com/P/${m[1]}` }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  pound: "£",
  euro: "€",
  yen: "¥",
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ""
    }
    return ENTITIES[name.toLowerCase()] ?? all
  })
}

function plain(html: string): string {
  return decode(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

/** The currency a shown price names by its sign; Noble Knight shows one per regional site. */
function currencyOf(price: string): string | undefined {
  if (/(?:CA|C)\$/.test(price)) return "CAD"
  if (/(?:AU|A)\$/.test(price)) return "AUD"
  if (price.includes("$")) return "USD"
  if (price.includes("£")) return "GBP"
  if (price.includes("€")) return "EUR"
  if (price.includes("¥")) return "JPY"
  return undefined
}

/**
 * The copies in stock on Noble Knight product page `html` for product `productId`, each a listing at
 * `url`, or null when the page is not that product's page (no `ppn_<id>` heading). Pure.
 */
export function readNobleKnightCopies(
  html: string,
  productId: string,
  url: string,
): Listing[] | null {
  const heading = new RegExp(`<h1[^>]*\\bppn_${productId}\\b[^>]*>([\\s\\S]*?)</h1>`, "i").exec(
    html,
  )
  const name = heading ? clean(plain(heading[1] ?? ""), TITLE_CHARS, true) : ""
  if (!name) return null
  const out: Listing[] = []
  const seen = new Set<string>()
  // Each row runs from its condition column to its own Add to Cart button. Related products further
  // down the page have buttons too, under other product ids, so a row counts only with this one's.
  const rows = html.split(/<div[^>]*class="[^"]*\bcondition-col\b/i).slice(1)
  for (const rest of rows) {
    if (out.length >= NOBLE_KNIGHT_MAX_COPIES) break
    const open = /^([^"]*)"/.exec(rest)
    if (!open || !/\bin_stock\b/.test(open[1] ?? "")) continue
    const button = new RegExp(`\\bid="${productId}#(\\d{4,14})"`).exec(rest)
    const sku = button?.[1]
    if (!sku || seen.has(sku)) continue
    const row = rest.slice(0, button.index)
    const label = /aria-label="Edit quantity Condition ([^"]*?) Price ([^"]*)"/i.exec(row)
    if (!label) continue
    const grade = clean(decode(label[1] ?? ""), CONDITION_CHARS, true)
    const shown = decode(label[2] ?? "")
    const price = parsePrice(shown)
    const noteMatch = /<span class="condition-note">([\s\S]*?)<\/span>/i.exec(row)
    const note = noteMatch
      ? clean(plain(noteMatch[1] ?? "").replace(/^\((.*)\)$/, "$1"), NOTE_CHARS, true)
      : ""
    const currency = currencyOf(shown)
    seen.add(sku)
    out.push({
      id: `nobleknight:${productId}#${sku}`,
      title: clean(
        `${name}${grade ? ` -- ${grade}` : ""}${note ? ` (${note})` : ""}`,
        TITLE_CHARS,
        true,
      ),
      url,
      ...(price !== null && price >= 0 ? { price } : {}),
      ...(currency ? { currency } : {}),
      ...(grade ? { condition: grade } : {}),
      seller: NOBLE_KNIGHT,
    })
  }
  return out
}

/** The `nobleknight` source: one product page per watch, its copies in stock as listings. */
export const nobleKnightSource: Source = {
  id: "nobleknight",
  async search(target: string, fetch: Fetch | undefined) {
    if (!fetch) throw new SourceMiss("this bot reads no pages")
    const product = nobleKnightProduct(target)
    if (!product) throw new SourceMiss("not a Noble Knight product page")
    let status: number
    let body: string
    try {
      const response = await fetch.get(product.url, { [NEVER_EBAY]: "1" })
      status = response.status
      body = response.body
    } catch (err) {
      throw new SourceMiss(`the read failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
    checkSearchStatus(status, NOBLE_KNIGHT, `${NOBLE_KNIGHT} refused the read (HTTP ${status})`)
    const copies = readNobleKnightCopies(body, product.id, product.url)
    if (copies === null) throw new SourceMiss("the page is not the product's page")
    return copies
  },
}
