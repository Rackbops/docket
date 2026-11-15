import { isObj, SOURCE_IDS, type SourceId } from "./want-sources.js"

/**
 * The places one want-list watch looks in (Rod, 2026-11-15, on the web area's New want-list watch
 * form: "This should be check boxes for multiple selections, not single pull down choices"). A
 * watch's first place is its `source` and `target`, as every watch has had; `also` adds the rest,
 * so a stored one-place watch, every reader that knows only `source`, and a host on an older
 * release all keep working: the shape is additive (rackbops-bot-plugins, the "Let watches look in
 * several places" plan).
 *
 * Each place is read as a one-place watch of its own (`pollWant`, unchanged), and the run merges
 * what they found into one DM, so one Done stops the watch everywhere. Pure.
 */

export interface WantPlace {
  source: SourceId
  /** As `WantConfig.target`: the page's address, the BGG game, the inbox's key, or the words to search for. */
  target: string
  /** An inbox place's search words and BGG game (the host's, as on a one-place inbox watch). */
  search?: string
  game?: string
  /**
   * The fewest hours between two looks at this place, when the watch polls more often than the
   * place may be read (a paid Shopify search): a look before then skips it. Absent, every look
   * reads it. The host sets it; this library holds no policy of its own about any source.
   */
  everyHours?: number
}

/** At most this many places beyond the first: one per source a watch can name. */
export const MAX_EXTRA_PLACES = 4

/** The longest `target` kept on an extra place, as a host's longest address. */
const TARGET_CHARS = 1000

/** A place's identity within its watch: its source and its target. */
export function placeKey(p: { source: string; target: string }): string {
  return `${p.source}:${p.target}`
}

/** One stored `also` entry, or null when it is not a place this release can read. */
function readPlace(v: unknown): WantPlace | null {
  if (!isObj(v)) return null
  const { source, target, search, game, everyHours } = v as Record<string, unknown>
  if (typeof source !== "string" || !(SOURCE_IDS as readonly string[]).includes(source)) return null
  if (typeof target !== "string" || target.trim() === "" || target.length > TARGET_CHARS)
    return null
  return {
    source: source as SourceId,
    target,
    ...(typeof search === "string" ? { search } : {}),
    ...(typeof game === "string" ? { game } : {}),
    ...(typeof everyHours === "number" && Number.isFinite(everyHours) && everyHours > 0
      ? { everyHours }
      : {}),
  }
}

/**
 * Every place a watch looks in, its first place first: then each readable `also` entry not the
 * same as one before it, at most `MAX_EXTRA_PLACES`. A watch with no `also` (every watch made
 * before it) has its one place. The first place carries the watch's own `search` and `game`.
 */
export function wantPlaces(config: {
  source: SourceId
  target: string
  search?: unknown
  game?: unknown
  also?: unknown
}): WantPlace[] {
  const first: WantPlace = {
    source: config.source,
    target: config.target,
    ...(typeof config.search === "string" ? { search: config.search } : {}),
    ...(typeof config.game === "string" ? { game: config.game } : {}),
  }
  const out = [first]
  const seen = new Set([placeKey(first)])
  const also = Array.isArray(config.also) ? config.also : []
  for (const raw of also) {
    if (out.length > MAX_EXTRA_PLACES) break
    const p = readPlace(raw)
    if (!p || seen.has(placeKey(p))) continue
    seen.add(placeKey(p))
    out.push(p)
  }
  return out
}

/** What a watch keeps about each place beyond its shared state: its own misses, and its last look. */
export interface PlaceState {
  misses: number
  warned: boolean
  /** When it was last read (ISO), for `everyHours`. */
  lastAt?: string
}

/** The `places` a stored state holds, each entry read defensively; any other value holds none. */
export function readPlaceStates(value: unknown): Record<string, PlaceState> {
  const out: Record<string, PlaceState> = {}
  if (!isObj(value)) return out
  const places = (value as { places?: unknown }).places
  if (!isObj(places)) return out
  for (const [key, v] of Object.entries(places as Record<string, unknown>)) {
    // A key is always `source:target`; one without a colon (`__proto__`) is never a place's.
    if (!key.includes(":") || !isObj(v)) continue
    const s = v as Record<string, unknown>
    out[key] = {
      misses: typeof s.misses === "number" && s.misses >= 0 ? s.misses : 0,
      warned: s.warned === true,
      ...(typeof s.lastAt === "string" && !Number.isNaN(Date.parse(s.lastAt))
        ? { lastAt: s.lastAt }
        : {}),
    }
  }
  return out
}

/** Whether `place` is due a look at `now`: always, unless its `everyHours` have not passed since its last. */
export function placeDue(place: WantPlace, state: PlaceState | undefined, now: Date): boolean {
  if (place.everyHours === undefined || !state?.lastAt) return true
  return now.getTime() - Date.parse(state.lastAt) >= place.everyHours * 3_600_000 - 60_000
}
