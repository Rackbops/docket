/**
 * Price extraction from a fetched page, structured sources first (city-hall#11): JSON-LD
 * `Product` / `Offer` blocks, then the product and Open Graph price meta tags, then any JSON
 * body, then a pattern the owner supplied. Pure string work on plain text, no DOM, no model;
 * the model fallback the plan budgets for (section 6) is a later type, not this one.
 */

export interface ExtractedPrice {
  value: number
  currency?: string
}

/**
 * Reads a number out of a price string: "$1,299.99", "1.299,99 EUR", "49,90", "USD 20". The
 * last separator followed by exactly two digits is the decimal mark; everything else is
 * grouping. Null when there is no digit.
 */
export function parsePrice(text: string): number | null {
  const m = /-?\d[\d.,\s]*/.exec(text.replace(/ /g, " "))
  if (!m) return null
  let digits = m[0].replace(/\s+/g, "")
  const negative = digits.startsWith("-")
  if (negative) digits = digits.slice(1)
  const decimal = /[.,](\d{1,2})$/.exec(digits)
  let whole = digits
  let fraction = ""
  if (decimal) {
    whole = digits.slice(0, decimal.index)
    fraction = decimal[1] ?? ""
  }
  whole = whole.replace(/[.,]/g, "")
  if (whole === "" && fraction === "") return null
  const value = Number(`${whole || "0"}.${fraction || "0"}`)
  if (!Number.isFinite(value)) return null
  return negative ? -value : value
}

const CURRENCY = /^[A-Z]{3}$/

function asCurrency(value: unknown): string | undefined {
  return typeof value === "string" && CURRENCY.test(value.trim().toUpperCase())
    ? value.trim().toUpperCase()
    : undefined
}

function asPrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") return parsePrice(value)
  return null
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The first price found walking a JSON value, offers before anything else at each level. */
export function priceFromJson(value: unknown, depth = 0): ExtractedPrice | null {
  if (depth > 12) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = priceFromJson(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const key of ["price", "lowPrice"]) {
    const price = asPrice(value[key])
    if (price !== null) {
      const currency = asCurrency(value.priceCurrency ?? value.currency)
      return currency ? { value: price, currency } : { value: price }
    }
  }
  const spec = value.priceSpecification
  if (spec) {
    const found = priceFromJson(spec, depth + 1)
    if (found) return found
  }
  if (value.offers) {
    const found = priceFromJson(value.offers, depth + 1)
    if (found) return found
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "offers" || key === "priceSpecification") continue
    const found = priceFromJson(child, depth + 1)
    if (found) return found
  }
  return null
}

const JSON_LD = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

/** JSON-LD blocks in a page, parsed; broken blocks are skipped. */
export function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = []
  for (const m of html.matchAll(JSON_LD)) {
    try {
      blocks.push(JSON.parse(m[1] ?? ""))
    } catch {
      // not JSON after all; the next block may be
    }
  }
  return blocks
}

const META_KEYS = ["product:price:amount", "og:price:amount", "price"]
const META_CURRENCY_KEYS = ["product:price:currency", "og:price:currency", "priceCurrency"]

function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const tag = new RegExp(
    `<meta[^>]*(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*>`,
    "i",
  ).exec(html)
  if (!tag) return null
  const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag[0])
  return content?.[1] ?? null
}

/** The price from the page's meta tags, when a product or Open Graph price is declared. */
export function priceFromMeta(html: string): ExtractedPrice | null {
  for (const key of META_KEYS) {
    const raw = metaContent(html, key)
    const value = raw === null ? null : parsePrice(raw)
    if (value === null) continue
    for (const ck of META_CURRENCY_KEYS) {
      const currency = asCurrency(metaContent(html, ck))
      if (currency) return { value, currency }
    }
    return { value }
  }
  return null
}

/** The first capture group of the owner's pattern, read as a price. */
export function priceFromPattern(body: string, pattern: string): ExtractedPrice | null {
  let re: RegExp
  try {
    re = new RegExp(pattern, "i")
  } catch {
    return null
  }
  const m = re.exec(body)
  const captured = m?.[1] ?? m?.[0]
  if (captured === undefined) return null
  const value = parsePrice(captured)
  return value === null ? null : { value }
}

/**
 * The price a fetched body carries: the owner's pattern when given, else JSON-LD, else meta
 * tags, else the body as JSON. Null when none of them yields a number.
 */
export function extractPrice(body: string, pattern?: string): ExtractedPrice | null {
  if (pattern) return priceFromPattern(body, pattern)
  for (const block of jsonLdBlocks(body)) {
    const found = priceFromJson(block)
    if (found) return found
  }
  const meta = priceFromMeta(body)
  if (meta) return meta
  const trimmed = body.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return priceFromJson(JSON.parse(trimmed))
    } catch {
      return null
    }
  }
  return null
}
