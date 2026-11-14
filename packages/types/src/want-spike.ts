import { clean, type Finding } from "@rackbops/docket-core"
import { currencyCode, money } from "./money.js"
import { type Listing, listingKey } from "./want-sources.js"

/**
 * Price spikes (docket#144). Rod, 2026-11-14: "if it's gradually climbing 2% a year, that's fine.
 * But if it's suddenly 150% of what it was yesterday, that one should not pass through", and "If
 * $350 is the normal price and suddenly you're seeing a single thing for $600, I don't need to see
 * that $600 one." No price cap: every copy at the usual price is told; one far above it is held.
 *
 * A watch's usual price, in one currency, is the median of the prices it has to compare: the ones
 * it kept from listings it told or ruled out (its state's `prices`: price, currency and day only,
 * never which listing), each raised 2% a year for its age, and this look's listings' prices. A
 * listing at 150% or more of that is held: never told or judged, remembered so it is not weighed
 * again, and kept as a finding tagged `price-spike` where the watch keeps findings. With fewer than
 * `MIN_PRICES` prices to compare, or for a listing with no price, nothing is held.
 */

/** One price a watch kept: the amount, its currency code ("" when unknown) and the day it was seen. */
export interface PricePoint {
  p: number
  c: string
  at: string
}

export const SPIKE_RATIO = 1.5
export const INFLATION_PER_YEAR = 0.02
export const MIN_PRICES = 3
/** The most prices a watch keeps, newest last. */
export const MAX_PRICES = 100
const YEAR_MS = 365.25 * 24 * 3600 * 1000

/** A watch's kept prices from its stored state, anything malformed dropped. Pure. */
export function readPrices(value: unknown): PricePoint[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (v): v is PricePoint =>
        typeof v === "object" &&
        v !== null &&
        typeof v.p === "number" &&
        Number.isFinite(v.p) &&
        v.p > 0 &&
        typeof v.c === "string" &&
        typeof v.at === "string" &&
        !Number.isNaN(Date.parse(v.at)),
    )
    .map((v) => ({ p: v.p, c: v.c, at: v.at }))
    .slice(-MAX_PRICES)
}

/** A listing's currency as a code, or "" when it names none or an invalid one. */
function codeOf(l: Listing): string {
  return currencyCode(l.currency) ?? ""
}

function priced(l: Listing): l is Listing & { price: number } {
  return typeof l.price === "number" && Number.isFinite(l.price) && l.price > 0
}

/** The median of `xs` (not empty). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

/**
 * The usual price in currency `code` at `now`, from the kept prices and this look's listings, or
 * null with fewer than `MIN_PRICES` to compare. Pure.
 */
export function usualPrice(
  kept: readonly PricePoint[],
  look: readonly Listing[],
  code: string,
  now: Date,
): number | null {
  const adjusted = kept
    .filter((k) => k.c === code)
    .map((k) => {
      const years = Math.max(0, (now.getTime() - Date.parse(k.at)) / YEAR_MS)
      return k.p * (1 + INFLATION_PER_YEAR) ** years
    })
  const current = look.filter((l) => priced(l) && codeOf(l) === code).map((l) => l.price as number)
  const all = [...adjusted, ...current]
  return all.length >= MIN_PRICES ? median(all) : null
}

/**
 * `candidates` split into those to go on and the spikes, each spike with the usual price it was
 * weighed against. `look` is everything this look read within the watch's limits (the candidates
 * among it). Pure.
 */
export function splitSpikes(
  candidates: readonly Listing[],
  look: readonly Listing[],
  kept: readonly PricePoint[],
  now: Date,
): { send: Listing[]; spikes: { listing: Listing; usual: number }[] } {
  const usual = new Map<string, number | null>()
  const send: Listing[] = []
  const spikes: { listing: Listing; usual: number }[] = []
  for (const l of candidates) {
    if (!priced(l)) {
      send.push(l)
      continue
    }
    const code = codeOf(l)
    if (!usual.has(code)) usual.set(code, usualPrice(kept, look, code, now))
    const u = usual.get(code) ?? null
    if (u !== null && l.price >= u * SPIKE_RATIO) spikes.push({ listing: l, usual: u })
    else send.push(l)
  }
  return { send, spikes }
}

/** The kept prices with `listings`' added (seen `now`), newest last, at most `MAX_PRICES`. Pure. */
export function keepPrices(
  kept: readonly PricePoint[],
  listings: readonly Listing[],
  now: Date,
): PricePoint[] {
  const day = now.toISOString().slice(0, 10)
  const added = listings.filter(priced).map((l) => ({ p: l.price, c: codeOf(l), at: day }))
  return [...kept, ...added].slice(-MAX_PRICES)
}

/** A held spike as a finding: kept in the watch's history, never DMed. */
export function spikeFinding(
  l: Listing & { price?: number },
  usual: number,
  source: string,
): Finding {
  const code = codeOf(l)
  return {
    text: clean(
      `${l.title} -- not sent: ${money(l.price ?? 0, code)} is ${Math.round(((l.price ?? 0) / usual) * 100)}% of the usual ${money(usual, code)}`,
      400,
      true,
    ),
    source: l.url,
    key: listingKey(`price-spike:${l.id}`),
    tags: ["wantlist", source, "price-spike"],
  }
}
