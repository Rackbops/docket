/**
 * Price extraction from a fetched page, structured sources first (Lepid-Labs/city-hall#11): JSON-LD
 * `Product` / `Offer` blocks, then the product and Open Graph price meta tags, then any JSON
 * body, then a pattern the owner supplied. Pure string work on plain text, no DOM, no model;
 * the model fallback the plan budgets for (section 6) is a later type, not this one.
 */

export interface ExtractedPrice {
  value: number
  currency?: string
}

/**
 * Reads a number out of a price string: "$1,299.99", "1.299,99 EUR", "49,90", "USD 20",
 * "1 299". The number ends at the first character that cannot continue it; a space continues it
 * only when exactly three digits follow (a thousands group), so "$12.99 2 left" is 12.99 and
 * "$20 50% off" is 20 (docket#39); and only before the first `.` or `,`. The last separator is the decimal mark when one, two, or four
 * or more digits follow it, or when three follow a whole part of 0 ("0.995"); three digits after
 * any other whole part are a thousands group, so "12.345" and "29.990" read as 12345 and 29990
 * (free text cannot tell those from a decimal). A JSON-LD or JSON price string goes through
 * `asPrice`, which reads a plain `.` decimal as one; meta tags, BGG's values and inbox prices come
 * here and keep the thousands reading.
 * Null when there is no digit.
 */
export function parsePrice(text: string): number | null {
  // Spaces join thousands groups only before the first separator, so "$12.99 100 in stock" is
  // 12.99 and "1 299,50" is 1299.5.
  const m = /-?\d(?:\d|\s(?=\d{3}(?!\d)))*(?:[.,][\d.,]*)?/.exec(text.replace(/\u00a0/g, " "))
  if (!m) return null
  let digits = m[0].replace(/\s+/g, "").replace(/[.,]+$/, "")
  const negative = digits.startsWith("-")
  if (negative) digits = digits.slice(1)
  let whole = digits
  let fraction = ""
  const last = /[.,](\d+)$/.exec(digits)
  if (last) {
    const tail = last[1] ?? ""
    const before = digits.slice(0, last.index).replace(/[.,]/g, "")
    const isDecimal = tail.length !== 3 || /^0*$/.test(before)
    if (isDecimal) {
      whole = digits.slice(0, last.index)
      fraction = tail
    }
  }
  whole = whole.replace(/[.,]/g, "")
  if (whole === "" && fraction === "") return null
  const value = Number(`${whole || "0"}.${fraction || "0"}`)
  if (!Number.isFinite(value)) return null
  return negative ? -value : value
}

/** A plain machine decimal, as schema.org and JSON bodies write a price: "29.990", "-5". */
const MACHINE_DECIMAL = /^\s*-?\d+(\.\d+)?\s*$/

const CURRENCY = /^[A-Z]{3}$/

function asCurrency(value: unknown): string | undefined {
  return typeof value === "string" && CURRENCY.test(value.trim().toUpperCase())
    ? value.trim().toUpperCase()
    : undefined
}

function asPrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    // A structured price is written with a `.` decimal, so read it as one (docket#39).
    if (MACHINE_DECIMAL.test(value)) {
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }
    return parsePrice(value)
  }
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

/** The longest owner pattern taken. */
export const MAX_PATTERN_CHARS = 300
/**
 * How much of a body an owner's pattern runs over. The price type runs on the notify lane, which
 * never waits (plan 5.3), and a pattern runs on the event loop. `patternProblem` refuses the
 * exponential shapes; the cap only limits the rest. It does not bound a polynomial one: an
 * unanchored `.*\$(\d+)` over a one-line body with no `$` grows with the square of the length
 * (about 6 s at 80,000 characters in review). A host that needs a hard bound runs the pattern
 * off the loop, with a timeout.
 */
export const MAX_PATTERN_BODY_CHARS = 500_000

/**
 * Why the owner's pattern is refused, or null when it is taken: it must parse, stay under
 * `MAX_PATTERN_CHARS`, and repeat no group that could match one stretch of text in many ways
 * (docket#45) -- a group that itself repeats (`(a+)+`, `(x*)*`, `(?:\d+,)*`) or holds an
 * alternation (`(a|a)*`, `(?:\s|&nbsp;)*`, `(.|\s)*`), the shapes that backtrack catastrophically
 * on about thirty characters. A heuristic, not a proof: it reads the pattern's text, skipping
 * escapes and character classes, and refuses some safe patterns (`(?:\d+,)*\d+`), which a
 * character class says as well (`[\d,]+`). A host checks it when a pattern is saved;
 * `priceFromPattern` refuses such a pattern too, and the price type never fetches with one.
 */
export function patternProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_CHARS) {
    return `the pattern is longer than ${MAX_PATTERN_CHARS} characters`
  }
  try {
    new RegExp(pattern, "i")
  } catch {
    return "the pattern is not a valid regular expression"
  }
  return repeatsAnAmbiguousGroup(pattern)
    ? "the pattern repeats a group that itself repeats or has a |, like (a+)+ or (a|b)*, " +
        "which can stall the tracker; use a character class, like [\\d,]+"
    : null
}

/** An unbounded quantifier at `i` in `p`: `*`, `+` or `{n,}`. */
function unboundedAt(p: string, i: number): boolean {
  const c = p[i]
  return c === "*" || c === "+" || /^\{\d+,\}/.test(p.slice(i))
}

/**
 * A repeating quantifier at `i`: unbounded, or `{n}` / `{n,m}` above 1. (`{,3}` is no quantifier
 * in a pattern without the `u` flag: it matches itself.)
 */
function repeatsAt(p: string, i: number): boolean {
  if (unboundedAt(p, i)) return true
  const m = /^\{(\d+)(?:,(\d+))?\}/.exec(p.slice(i))
  return m !== null && Number(m[2] ?? m[1]) > 1
}

function repeatsAnAmbiguousGroup(p: string): boolean {
  // One entry per open group: whether anything inside it repeats without bound, and whether it
  // holds an alternation (its own `|`, or one in an unrepeated group inside it).
  const open: { repeats: boolean; alt: boolean }[] = []
  const top = () => open[open.length - 1]
  let inside = false
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === "\\") {
      i++
      continue
    }
    if (inside) {
      if (c === "]") inside = false
      continue
    }
    if (c === "[") {
      inside = true
      if (p[i + 1] === "]") i++
      continue
    }
    if (c === "(") {
      open.push({ repeats: false, alt: false })
      continue
    }
    if (c === "|") {
      const g = top()
      if (g) g.alt = true
      continue
    }
    if (c === ")") {
      const g = open.pop() ?? { repeats: false, alt: false }
      const repeated = repeatsAt(p, i + 1)
      if (repeated && (g.repeats || g.alt)) return true
      const parent = top()
      if (parent) {
        if (g.repeats || unboundedAt(p, i + 1)) parent.repeats = true
        if (g.alt && !repeated) parent.alt = true
      }
      continue
    }
    const g = top()
    if (g && unboundedAt(p, i)) g.repeats = true
  }
  return false
}

/**
 * The first capture group of the owner's pattern, read as a price, over at most
 * `MAX_PATTERN_BODY_CHARS` of the body. A pattern `patternProblem` refuses reads nothing.
 */
export function priceFromPattern(body: string, pattern: string): ExtractedPrice | null {
  if (patternProblem(pattern) !== null) return null
  const re = new RegExp(pattern, "i")
  const m = re.exec(body.slice(0, MAX_PATTERN_BODY_CHARS))
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
