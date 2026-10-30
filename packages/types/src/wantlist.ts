import {
  clean,
  defineTaskType,
  type Finding,
  type Outcome,
  type ReplyContext,
  type RunContext,
  type TaskType,
} from "@rackbops/docket-core"
import { currencyCode, money } from "./money.js"
import { MISSES_BEFORE_TELLING } from "./price.js"
import { EBAY_CURRENCY } from "./want-ebay.js"
import { wordsOf } from "./want-shopify.js"
import {
  type Listing,
  listingKey,
  type Source,
  type SourceId,
  SourceMiss,
  SourceUnavailableError,
} from "./want-sources.js"
import { sourceText } from "./want-text.js"

/**
 * The want-list watcher (category 2, plan 1.2 row 2; rackbops-bot-plugins#83): one task per wanted
 * thing, read from one source (want-sources.ts) on a `poll` schedule. Each run lists what the source
 * has now, keeps those at or under the owner's top price, and DMs the ones it has not told them of
 * before, up to `SHOWN_IN_DM` lines, each kept as a finding (plan 5.2), with a Done button: the
 * thing is found, the task ends. A read that yields nothing counts as a miss, and the owner hears
 * once, at `MISSES_BEFORE_TELLING` in a row (the price tracker's rule). Notify lane, tier 0, no
 * model; the judged watch (wantjudge.ts) is the one that has the model look first (5.4).
 *
 * Built in the tracker plugin (rackbops-bot-plugins#119, tracker 0.16.0) and given to docket
 * in 0.6.0 (plan item 104). The sources are a parameter (`wantlistType`): a host builds the type
 * over the ones it can run.
 */

export interface WantConfig {
  source: SourceId
  /** The page's address, the BGG game (an id or its address), or the inbox's key (the host's). */
  target: string
  /** Only listings at or under this, in `currency` when one is set. */
  maxPrice?: number
  /** Only listings in this currency; a listing that names none passes. */
  currency?: string
  /**
   * Words or phrases that rule a listing out: one whose title holds any of them, as whole words in
   * that order, is dropped when the source is read, so it is never told; a judged watch checks its
   * waiting listings again when it settles them (docket#77). Absent or empty, nothing is.
   */
  exclude?: string[]
  /**
   * Words or phrases that confirm a listing is the thing wanted (0.20.0, Rod, 2026-10-30, the Arkham
   * watch: "leave it out, then double check any that don't have it"). A listing whose title has one
   * is confirmed; one whose title has none is read in full where its source can (`Source.detail`,
   * eBay's) and confirmed when that has one. A listing still not confirmed is dropped when its title
   * or full text has an `unconfirmed` entry, and is otherwise told marked for the owner to check.
   * Absent or empty, every listing counts as confirmed, as before.
   */
  confirm?: string[]
  /** Words or phrases that rule out a listing only when `confirm` did not confirm it ("investigator"). */
  unconfirmed?: string[]
}

export interface WantState {
  /** `listingKey`s of the listings already DMed, newest last, at most `MAX_REPORTED`. */
  reported: string[]
  /** Reads in a row that yielded nothing. */
  misses: number
  /** Listings DMed in all. */
  told: number
  /** Whether this run of misses has been told about already: once per run, whatever the reason. */
  warned: boolean
}

export const MAX_REPORTED = 500
export const SHOWN_IN_DM = 5

/**
 * Whether a watch keeps its listings as findings. An eBay API watch keeps none (Rod, 2026-10-20,
 * the account-deletion card): eBay's API License wants shown listing data at most six hours old
 * and seller names deleted on eBay's notice, and an app may opt out of those notices only when it
 * keeps no eBay data. Its state still remembers each listing told, as a digest of its id only.
 */
export function keepsFindings(config: WantConfig): boolean {
  return config.source !== "ebay"
}

/** The DM's last line when more listings are new than it shows. */
export function moreLine(more: number, taskId: string, config: WantConfig): string {
  return keepsFindings(config)
    ? `...and ${more} more: \`/task history ${taskId}\` lists them all.`
    : `...and ${more} more, not kept here: eBay's own search shows them.`
}
/** New listings taken in one run, DMed and kept as findings; any more wait for the next run. */
export const MAX_NEW_PER_RUN = 20

/** The longest DM text a type here builds; Discord's limit is 2,000. */
export const MAX_DM_CHARS = 2000

/** `text`, cut to `max` with an ellipsis. */
export function clip(text: string, max = MAX_DM_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

/** Text from a shop, with any address in it broken, so Discord neither links nor previews it; only the listing's own link does. */
export function inert(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*):\/\//gi, "$1:/\u200b/")
    .replace(/\bwww\./gi, "www\u200b.")
}

export function wantState(value: unknown): WantState {
  const s = value as Partial<WantState> | null
  if (!s || typeof s !== "object") return { reported: [], misses: 0, told: 0, warned: false }
  return {
    reported: Array.isArray(s.reported)
      ? s.reported.filter((k): k is string => typeof k === "string").slice(-MAX_REPORTED)
      : [],
    misses: typeof s.misses === "number" ? s.misses : 0,
    told: typeof s.told === "number" ? s.told : 0,
    warned: s.warned === true,
  }
}

/**
 * Whether a listing is within the owner's limits: an unknown price never passes a top price, a
 * negative one never passes at all, whatever the source (docket#57); currencies compare as codes
 * (`currencyCode`), so an invalid one on the watch limits nothing (docket#58).
 */
export function withinLimits(l: Listing, config: WantConfig): boolean {
  if (l.price !== undefined && !(l.price >= 0)) return false
  const want = currencyCode(config.currency)
  if (want && l.currency && currencyCode(l.currency) !== want) return false
  if (config.maxPrice === undefined) return true
  return l.price !== undefined && l.price <= config.maxPrice + 1e-9
}

/** At most this many exclude entries, each at most `EXCLUDE_CHARS`; more is cut, never an error. */
export const MAX_EXCLUDE = 20
export const EXCLUDE_CHARS = 80

/**
 * The exclude entries in `text`, as a host reads them from one field: split at commas and line
 * breaks, trimmed, capped; an entry with no words in it is dropped, and so is one that repeats an
 * earlier one on the word split (`wordsOf`: case, accents and punctuation folded). Pure.
 */
export function parseExclude(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/[,\n]/)) {
    const entry = raw.trim().slice(0, EXCLUDE_CHARS).trim()
    const key = wordsOf(entry).join(" ")
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(entry)
    if (out.length === MAX_EXCLUDE) break
  }
  return out
}

/**
 * Whether `title` holds any entry of `exclude` as whole words in that order, on the same word split
 * as the target's (`wordsOf`: case and accents folded, punctuation ignored), so "investigator"
 * rules out "Edge of the Earth: Investigator Expansion" and "investigator expansion" does too, but
 * "investigators" does not. A stored string is read as one comma-separated field (`parseExclude`),
 * so a host that stored the intake field as it came still excludes; any other value that is not a
 * list of strings excludes nothing. Pure.
 */
export function isExcluded(title: string, value: unknown): boolean {
  const exclude = typeof value === "string" ? parseExclude(value) : value
  if (!Array.isArray(exclude) || exclude.length === 0) return false
  const have = wordsOf(title)
  return exclude.slice(0, MAX_EXCLUDE).some((entry) => {
    if (typeof entry !== "string") return false
    const want = wordsOf(entry.slice(0, EXCLUDE_CHARS))
    if (want.length === 0) return false
    for (let i = 0; i + want.length <= have.length; i++) {
      if (want.every((w, j) => have[i + j] === w)) return true
    }
    return false
  })
}

/** Whether a listing is one the owner wants told of: within the limits and not excluded (`confirm` aside: it needs the source). */
export function wanted(l: Listing, config: WantConfig): boolean {
  return withinLimits(l, config) && !isExcluded(l.title, config.exclude)
}

export function priceText(l: Listing, config: WantConfig): string {
  return l.price === undefined
    ? "price not shown"
    : money(l.price, l.currency ?? config.currency ?? "")
}

/** The mark on a listing `confirm` did not confirm, for the owner to check by eye. */
export function checkMark(config: WantConfig): string {
  const first = Array.isArray(config.confirm) ? config.confirm[0] : undefined
  return `check: not confirmed as "${inert(clean(String(first ?? ""), EXCLUDE_CHARS, true))}"`
}

/** One DM line: what, how much, its shipping, condition and seller, then the link in <...> (no embed). */
export function listingLine(l: Listing, config: WantConfig, unconfirmed = false): string {
  const parts = [
    ...(unconfirmed ? [checkMark(config)] : []),
    inert(l.title),
    priceText(l, config),
    ...(l.shipping ? [inert(l.shipping)] : []),
    ...(l.condition ? [inert(l.condition)] : []),
    ...(l.seller ? [`sold by ${inert(l.seller)}`] : []),
  ]
  const attribution = sourceText(config.source).attribution
  const via = attribution ? ` (${attribution})` : ""
  return `- ${parts.join(" -- ")} <${l.url}>${via}`
}

export function renderWant(
  title: string,
  taskId: string,
  fresh: readonly Listing[],
  config: WantConfig,
  unchecked?: ReadonlySet<string>,
): string {
  const lines = [
    `${title}: ${fresh.length === 1 ? "a new listing" : `${fresh.length} new listings`}.`,
  ]
  for (const l of fresh.slice(0, SHOWN_IN_DM)) {
    lines.push(listingLine(l, config, unchecked?.has(l.id) === true))
  }
  if (fresh.length > SHOWN_IN_DM) lines.push(moreLine(fresh.length - SHOWN_IN_DM, taskId, config))
  lines.push("Press Done once you have it, and I stop looking.")
  return clip(lines.join("\n"))
}

export function miss<S extends WantState>(
  ctx: RunContext<WantConfig>,
  state: S,
  err: unknown,
): Outcome {
  const reason = err instanceof Error ? err.message : String(err)
  const misses = state.misses + 1
  const tell =
    !state.warned && (misses >= MISSES_BEFORE_TELLING || err instanceof SourceUnavailableError)
  const outcome: Outcome = {
    state: { ...state, misses, warned: state.warned || tell },
    summary: `nothing read: ${reason}`,
  }
  if (tell) {
    const where = sourceText(ctx.config.source).where ?? ctx.config.target
    outcome.notify = {
      text: clip(
        `${ctx.task.title}: I could read no listings from ${where} ${misses === 1 ? "just now" : `${misses} times in a row`} (${reason}). ` +
          "I keep looking; press Done to stop.",
      ),
      actions: ["done"],
    }
  }
  return outcome
}

/** A finding for one listing: what it is, its price, and `extra` (a verdict); keyed so it is stored once. */
export function listingFinding(
  l: Listing,
  config: WantConfig,
  said: string,
  tags: readonly string[] = [],
): Finding {
  return {
    text: clip(`${l.title} -- ${said}${l.condition ? ` -- ${l.condition}` : ""}`, 400),
    source: l.url,
    key: listingKey(l.id),
    tags: ["wantlist", config.source, ...tags],
  }
}

/**
 * One look at the source: either the run's outcome already (a miss, or nothing new, with the state
 * it leaves), or the listings within the limits not told before, at most `MAX_NEW_PER_RUN`, with the
 * state after a good read (misses cleared) for the caller to add them to. Shared by the plain watch
 * (DMs them) and the judged one (wantjudge.ts, has the model look first).
 */
export type Polled =
  | { kind: "done"; outcome: Outcome }
  | {
      kind: "fresh"
      state: WantState
      fresh: Listing[]
      summary: string
      /** The ids of fresh listings `confirm` did not confirm: told marked for the owner to check. */
      unchecked: Set<string>
    }

export async function pollWant(
  ctx: RunContext<WantConfig>,
  sources: Partial<Record<SourceId, Source>>,
  stored?: WantState,
): Promise<Polled> {
  const state = stored ?? wantState(ctx.state)
  const source = sources[ctx.config.source]
  if (!source) {
    return {
      kind: "done",
      outcome: miss(
        ctx,
        state,
        new SourceUnavailableError(`this bot has no ${sourceText(ctx.config.source).missing}`),
      ),
    }
  }
  // The eBay source searches eBay US, which lists prices in USD only, so a watch in any other
  // currency would read fine every time and drop every listing on currency: say so at once
  // rather than look healthy forever.
  // An invalid code counts as none named, as everywhere (`currencyCode`, docket#58).
  const currency = currencyCode(ctx.config.currency)
  if (ctx.config.source === "ebay" && currency && currency !== EBAY_CURRENCY) {
    return {
      kind: "done",
      outcome: miss(
        ctx,
        state,
        new SourceUnavailableError(
          `eBay US lists prices in ${EBAY_CURRENCY} only, so a watch in ${currency} never matches; ` +
            `set the currency to ${EBAY_CURRENCY} or leave it out`,
        ),
      ),
    }
  }
  let listings: Listing[]
  try {
    listings = await source.search(ctx.config.target, ctx.ports.fetch, {
      ...(ctx.config.maxPrice !== undefined ? { maxPrice: ctx.config.maxPrice } : {}),
      ...(ctx.config.currency ? { currency: ctx.config.currency } : {}),
    })
  } catch (err) {
    if (err instanceof SourceMiss) return { kind: "done", outcome: miss(ctx, state, err) }
    throw err
  }
  const told = new Set(state.reported)
  const limited = listings.filter((l) => withinLimits(l, ctx.config))
  const within = limited.filter((l) => !isExcluded(l.title, ctx.config.exclude))
  const candidates = within.filter((l) => !told.has(listingKey(l.id))).slice(0, MAX_NEW_PER_RUN)
  const checked = await confirmListings(candidates, ctx.config, source)
  const fresh = checked.kept
  const dropped = limited.length - within.length
  const ruled = checked.ruledOut.length
  const summary =
    `${listings.length} listed, ${limited.length} within limits, ` +
    `${dropped > 0 ? `${dropped} excluded, ` : ""}` +
    `${ruled > 0 ? `${ruled} not confirmed and ruled out, ` : ""}` +
    `${checked.unchecked.size > 0 ? `${checked.unchecked.size} to check, ` : ""}${fresh.length} new`
  // A listing ruled out is remembered as told, so it is not read in full again on every look.
  const read: WantState = {
    ...state,
    misses: 0,
    warned: false,
    reported: [...state.reported, ...checked.ruledOut.map((l) => listingKey(l.id))].slice(
      -MAX_REPORTED,
    ),
  }
  if (fresh.length === 0) return { kind: "done", outcome: { state: read, summary } }
  return { kind: "fresh", state: read, fresh, summary, unchecked: checked.unchecked }
}

/** Whether `text` has a `confirm` entry: the same whole-word match as `exclude`'s. */
function confirms(text: string, config: WantConfig): boolean {
  return isExcluded(text, config.confirm)
}

/** Whether a watch has `confirm` words; a stored comma-separated string counts, as for `exclude`. */
export function hasConfirm(config: WantConfig): boolean {
  const c: unknown = config.confirm
  return typeof c === "string" ? parseExclude(c).length > 0 : Array.isArray(c) && c.length > 0
}

/**
 * New listings through `confirm` (above): each read in full where the source can, which also gives
 * its shipping, so every listing a source can read is read once, before it is told. Kept are the
 * confirmed and the ones to check (their ids in `unchecked`); `ruledOut` are the unconfirmed ones an
 * `unconfirmed` entry rules out. A watch with no `confirm` keeps every listing, shipping added.
 */
export async function confirmListings(
  listings: readonly Listing[],
  config: WantConfig,
  source: Source,
): Promise<{ kept: Listing[]; unchecked: Set<string>; ruledOut: Listing[] }> {
  const kept: Listing[] = []
  const ruledOut: Listing[] = []
  const unchecked = new Set<string>()
  const confirming = hasConfirm(config)
  for (const l of listings) {
    const detail = source.detail ? await source.detail(l) : null
    const full = detail?.shipping ? { ...l, shipping: detail.shipping } : l
    if (!confirming || confirms(l.title, config) || (detail && confirms(detail.text, config))) {
      kept.push(full)
      continue
    }
    if (
      isExcluded(l.title, config.unconfirmed) ||
      (detail !== null && isExcluded(detail.text, config.unconfirmed))
    ) {
      ruledOut.push(full)
      continue
    }
    unchecked.add(l.id)
    kept.push(full)
  }
  return { kept, unchecked, ruledOut }
}

/** The type over `sources`: a task whose source this bot lacks (BGG without its token) counts misses. */
export function wantlistType(sources: Partial<Record<SourceId, Source>>): TaskType<WantConfig> {
  return defineTaskType<WantConfig>({
    id: "wantlist",
    lane: "notify",
    capabilities: ["notify"],
    schedule: ["poll"],
    intake: {
      options: [
        {
          name: "source",
          description: "Where to look: page, bgg, inbox, shopify or ebay",
          required: true,
          kind: "string",
        },
        {
          name: "target",
          description:
            "The page's address, the BGG game, the inbox's key, or the words to search Shopify or eBay for",
          required: true,
          kind: "string",
        },
        {
          name: "max",
          description: "Only listings at or under this price",
          required: false,
          kind: "number",
        },
        {
          name: "currency",
          description: "Only listings in this currency",
          required: false,
          kind: "string",
        },
        {
          name: "exclude",
          description:
            "Leave out listings whose title has any of these words or phrases, separated by commas",
          required: false,
          kind: "string",
        },
        {
          name: "confirm",
          description:
            "Words or phrases that confirm a listing, separated by commas; one whose title has none is read in full where the source can, then ruled out by `unconfirmed` or told marked to check",
          required: false,
          kind: "string",
        },
        {
          name: "unconfirmed",
          description:
            "Leave out a listing `confirm` did not confirm when its title or full listing has any of these, separated by commas",
          required: false,
          kind: "string",
        },
      ],
    },
    async run(ctx: RunContext<WantConfig>): Promise<Outcome> {
      const polled = await pollWant(ctx, sources)
      if (polled.kind === "done") return polled.outcome
      const { state, fresh, summary, unchecked } = polled
      return {
        state: {
          ...state,
          reported: [...state.reported, ...fresh.map((l) => listingKey(l.id))].slice(-MAX_REPORTED),
          told: state.told + fresh.length,
        },
        notify: {
          text: renderWant(ctx.task.title, ctx.task.id, fresh, ctx.config, unchecked),
          actions: ["done"],
        },
        ...(keepsFindings(ctx.config)
          ? { findings: fresh.map((l) => listingFinding(l, ctx.config, priceText(l, ctx.config))) }
          : {}),
        summary,
      }
    },
    async onReply(ctx: ReplyContext<WantConfig>): Promise<Outcome> {
      if (ctx.reply.kind === "done") return { complete: true, summary: "found it; stopped looking" }
      return {}
    },
  })
}
