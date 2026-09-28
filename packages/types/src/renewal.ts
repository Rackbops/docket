import {
  daysUntil,
  defineTaskType,
  type Outcome,
  periodDate,
  type ReplyContext,
  type RunContext,
  type SeriesObservation,
  wallClock,
} from "@rackbops/docket-core"
import { money } from "./money.js"
import { snoozeUntil } from "./reminder.js"

/**
 * Category 6 (plan section 1.2, city-hall#11): subscriptions, warranties, domains, memberships.
 * A `period` schedule rolls from the renewal date, firing `leadDays` before it; the reminder
 * asks keep / cancel / renewed; the decision and the amount are recorded per period -- the
 * current row in the task's state, the history in replies and the series -- and a cancel ends
 * the task. Notify lane, tier 0, no model.
 */

export interface RenewalConfig {
  /** What one period costs, as first entered. */
  amount: number
  /** ISO 4217 code, e.g. `USD`. */
  currency: string
  /** A line carried on every reminder: where to cancel, which account, ... */
  note?: string
}

export const RENEWAL_DECISIONS = ["keep", "cancel", "renewed"] as const

export type RenewalDecision = (typeof RENEWAL_DECISIONS)[number]

export function isRenewalDecision(value: string): value is RenewalDecision {
  return (RENEWAL_DECISIONS as readonly string[]).includes(value)
}

/** The current row: the amount as last reported, and the last decision taken. */
export interface RenewalState {
  amount: number
  decision: RenewalDecision | null
  decidedAt: string | null
  /** The period date the last decision was about. */
  periodDate: string | null
}

function stateOf(ctx: RunContext<RenewalConfig>): RenewalState {
  const s = ctx.state as Partial<RenewalState> | null
  if (s && typeof s.amount === "number" && Number.isFinite(s.amount)) {
    return {
      amount: s.amount,
      decision: s.decision ?? null,
      decidedAt: s.decidedAt ?? null,
      periodDate: s.periodDate ?? null,
    }
  }
  return { amount: ctx.config.amount, decision: null, decidedAt: null, periodDate: null }
}

/** A decision reply's payload: `"keep"`, or `{ choice, amount? }` with a newly paid amount. */
export function decisionOf(payload: unknown): {
  choice: RenewalDecision | null
  amount: number | null
} {
  if (typeof payload === "string") {
    return { choice: isRenewalDecision(payload) ? payload : null, amount: null }
  }
  if (typeof payload === "object" && payload !== null) {
    const p = payload as { choice?: unknown; amount?: unknown }
    const choice = typeof p.choice === "string" && isRenewalDecision(p.choice) ? p.choice : null
    const amount =
      typeof p.amount === "number" && Number.isFinite(p.amount) && p.amount >= 0 ? p.amount : null
    return { choice, amount }
  }
  return { choice: null, amount: null }
}

/**
 * The period date this occurrence is about: from the schedule, or the due day itself. A snooze's
 * run is about the period its first run asked about, so it reads that run's due instant.
 */
function periodDateOf(ctx: RunContext<RenewalConfig>): string {
  const due = new Date(ctx.originalDueAt ?? ctx.occurrence.dueAt)
  const zone = ctx.owner.timeZone
  if (ctx.task.schedule?.kind === "period") return periodDate(ctx.task.schedule, due, zone)
  const w = wallClock(due, zone)
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

function when(date: string, ctx: RunContext<RenewalConfig>): string {
  const days = daysUntil(date, ctx.now, ctx.owner.timeZone)
  if (days === null || days > 0) {
    return days === null ? `on ${date}` : `on ${date}, in ${plural(days, "day")}`
  }
  return days === 0 ? `today, ${date}` : `on ${date}, ${plural(-days, "day")} ago`
}

export const renewal = defineTaskType<RenewalConfig>({
  id: "renewal",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["period", "once"],
  intake: {
    options: [
      { name: "amount", description: "What one period costs", required: true, kind: "number" },
      { name: "currency", description: "Currency code, e.g. USD", required: true, kind: "string" },
      {
        name: "renews",
        description: "The next renewal or expiry date, YYYY-MM-DD",
        required: true,
        kind: "string",
      },
      {
        name: "every",
        description: "Periods between renewals (with unit); default 1",
        required: false,
        kind: "integer",
      },
      {
        name: "unit",
        description: "day, week, month or year; default year",
        required: false,
        kind: "string",
      },
      {
        name: "lead",
        description: "Days before the date to ask; default 7",
        required: false,
        kind: "integer",
      },
      { name: "note", description: "Carried on every reminder", required: false, kind: "string" },
    ],
  },
  async run(ctx: RunContext<RenewalConfig>): Promise<Outcome> {
    const state = stateOf(ctx)
    const date = periodDateOf(ctx)
    const cost = money(state.amount, ctx.config.currency)
    const lines = [
      `${ctx.task.title} renews ${when(date, ctx)}: ${cost}. Keep it, cancel it, or mark it renewed.`,
    ]
    if (ctx.config.note) lines.push(ctx.config.note)
    const paid = ctx.history.series.filter((p) => p.note === "keep" || p.note === "renewed")
    if (paid.length > 0) {
      const total = paid.reduce((sum, p) => sum + p.value, 0)
      lines.push(`So far: ${plural(paid.length, "period")}, ${money(total, ctx.config.currency)}.`)
    }
    if (state.decision && state.periodDate) {
      lines.push(`Last time (${state.periodDate}): ${state.decision}.`)
    }
    return {
      notify: {
        text: lines.join("\n"),
        actions: ["decision", "snooze"],
        decisions: [...RENEWAL_DECISIONS],
      },
      summary: `asked: renews ${date} for ${cost}`,
    }
  },
  async onReply(ctx: ReplyContext<RenewalConfig>): Promise<Outcome> {
    if (ctx.reply.kind === "snooze") {
      const until = snoozeUntil(ctx.reply.payload, ctx.now)
      return { snoozeUntil: until, summary: `snoozed until ${until.toISOString()}` }
    }
    if (ctx.reply.kind !== "decision") return {}
    const { choice, amount } = decisionOf(ctx.reply.payload)
    if (!choice) return { summary: `decision not understood; say ${RENEWAL_DECISIONS.join(", ")}` }
    const previous = stateOf(ctx)
    const date = periodDateOf(ctx)
    const state: RenewalState = {
      amount: amount ?? previous.amount,
      decision: choice,
      decidedAt: ctx.now.toISOString(),
      periodDate: date,
    }
    if (choice === "cancel") return { state, complete: true, summary: `cancelled before ${date}` }
    const point: SeriesObservation = {
      value: state.amount,
      unit: ctx.config.currency,
      note: choice,
    }
    return {
      state,
      series: [point],
      summary: `${choice} for ${date} at ${money(state.amount, ctx.config.currency)}`,
    }
  },
})
