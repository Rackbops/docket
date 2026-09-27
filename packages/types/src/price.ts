import {
  defineTaskType,
  type Outcome,
  type ReplyContext,
  type RunContext,
  type SeriesObservation,
} from "@rackbops/docket-core"
import { extractPrice } from "./extract.js"
import { money } from "./money.js"

/**
 * Category 3 (plan section 1.2, city-hall#11): track an item's price, record it, alert when it
 * drops by 10% or more. A `poll` schedule; each run reads the page through the Fetch port,
 * extracts the price (structured sources first, `extract.ts`), appends it to the task's series
 * and compares it with the baseline the owner chose -- first seen, last seen or the peak --
 * alerting once per crossing of the line. Notify lane, tier 0, no model.
 */

export const BASELINE_RULES = ["first", "last", "peak"] as const

export type BaselineRule = (typeof BASELINE_RULES)[number]

export const DEFAULT_DROP_PERCENT = 10
export const DEFAULT_BASELINE: BaselineRule = "last"
/** Consecutive polls without a price before the owner is told, once. */
export const MISSES_BEFORE_TELLING = 3

export interface PriceConfig {
  url: string
  /** Alert on a drop of at least this much, in percent of the baseline; default 10. */
  dropPercent?: number
  /** What a drop is measured from; default `last`. */
  baseline?: BaselineRule
  /** A regular expression whose first group is the price, for a page with no structured price. */
  pattern?: string
  /** Shown with the price when the page declares no currency. */
  currency?: string
}

/** The current row: what has been seen, and whether the price sits under the alert line. */
export interface PriceState {
  first: number | null
  last: number | null
  peak: number | null
  /** True while the price is at or below the line, so one crossing alerts once. */
  below: boolean
  /** Consecutive polls that yielded no price. */
  misses: number
  alerts: number
}

const FRESH: PriceState = {
  first: null,
  last: null,
  peak: null,
  below: false,
  misses: 0,
  alerts: 0,
}

function stateOf(value: unknown): PriceState {
  const s = value as Partial<PriceState> | null
  if (!s || typeof s !== "object" || typeof s.misses !== "number") return { ...FRESH }
  return {
    first: s.first ?? null,
    last: s.last ?? null,
    peak: s.peak ?? null,
    below: s.below ?? false,
    misses: s.misses,
    alerts: s.alerts ?? 0,
  }
}

function dropPercent(config: PriceConfig): number {
  const d = config.dropPercent
  return typeof d === "number" && Number.isFinite(d) && d > 0 && d < 100 ? d : DEFAULT_DROP_PERCENT
}

function baselineRule(config: PriceConfig): BaselineRule {
  return config.baseline && (BASELINE_RULES as readonly string[]).includes(config.baseline)
    ? config.baseline
    : DEFAULT_BASELINE
}

/** The price a drop is measured from under `rule`, or null before anything was seen. */
export function reference(state: PriceState, rule: BaselineRule): number | null {
  switch (rule) {
    case "first":
      return state.first
    case "last":
      return state.last
    case "peak":
      return state.peak
  }
}

function miss(ctx: RunContext<PriceConfig>, state: PriceState, reason: string): Outcome {
  const misses = state.misses + 1
  const outcome: Outcome = { state: { ...state, misses }, summary: `no price: ${reason}` }
  if (misses === MISSES_BEFORE_TELLING) {
    outcome.notify = {
      text:
        `${ctx.task.title}: no price read from ${ctx.config.url} ${misses} polls in a row ` +
        `(${reason}). Check the page or the pattern; reply done to stop tracking.`,
      actions: ["done"],
    }
  }
  return outcome
}

export const price = defineTaskType<PriceConfig>({
  id: "price",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["poll"],
  intake: {
    options: [
      { name: "url", description: "The product page", required: true, kind: "string" },
      { name: "every", description: "Hours between checks", required: true, kind: "integer" },
      {
        name: "drop",
        description: "Alert on a drop of at least this percent; default 10",
        required: false,
        kind: "number",
      },
      {
        name: "baseline",
        description: "Measure the drop from the first, last or peak price seen; default last",
        required: false,
        kind: "string",
      },
      {
        name: "pattern",
        description: "A regular expression whose first group is the price, if the page needs one",
        required: false,
        kind: "string",
      },
    ],
  },
  async run(ctx: RunContext<PriceConfig>): Promise<Outcome> {
    const { fetch } = ctx.ports
    if (!fetch) throw new Error("the price type needs the Fetch port; the host configured none")
    const state = stateOf(ctx.state)
    let body: string
    try {
      const response = await fetch.get(ctx.config.url)
      if (response.status !== 200) return miss(ctx, state, `HTTP ${response.status}`)
      body = response.body
    } catch (err) {
      return miss(ctx, state, `fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const found = extractPrice(body, ctx.config.pattern)
    if (!found) return miss(ctx, state, "no price in the page")
    const seen = found.value
    const currency = found.currency ?? ctx.config.currency ?? ""
    const point: SeriesObservation = currency
      ? { value: seen, unit: currency, note: "observed" }
      : { value: seen, note: "observed" }
    const rule = baselineRule(ctx.config)
    const drop = dropPercent(ctx.config)
    const ref = reference(state, rule)
    if (ref === null) {
      return {
        state: { first: seen, last: seen, peak: seen, below: false, misses: 0, alerts: 0 },
        series: [point],
        notify: {
          text:
            `Now tracking ${ctx.task.title} at ${money(seen, currency)}. I will say when it ` +
            `drops ${drop}% or more from the ${rule} price seen. ${ctx.config.url}`,
          actions: ["done"],
        },
        summary: `baseline ${money(seen, currency)}`,
      }
    }
    const line = ref * (1 - drop / 100)
    const below = seen <= line + 1e-9
    const crossing = below && !state.below
    const next: PriceState = {
      first: state.first ?? seen,
      last: seen,
      peak: Math.max(state.peak ?? seen, seen),
      below,
      misses: 0,
      alerts: state.alerts + (crossing ? 1 : 0),
    }
    if (!crossing) {
      return {
        state: next,
        series: [point],
        summary: `${money(seen, currency)} (${rule} ${money(ref, currency)})`,
      }
    }
    const pct = Math.round(((ref - seen) / ref) * 100)
    return {
      state: next,
      series: [point],
      notify: {
        text:
          `${ctx.task.title}: ${money(seen, currency)}, down ${pct}% from ` +
          `${money(ref, currency)} (${rule} seen). ${ctx.config.url}`,
        actions: ["done"],
      },
      summary: `alert: ${money(seen, currency)}, down ${pct}% from ${money(ref, currency)}`,
    }
  },
  async onReply(ctx: ReplyContext<PriceConfig>): Promise<Outcome> {
    if (ctx.reply.kind === "done") return { complete: true, summary: "stopped tracking" }
    return {}
  },
})
