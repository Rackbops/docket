import type { Usage, UsageSource, User } from "./model.js"
import type { Notifier, OutgoingMessage, Store } from "./ports.js"
import { wallClock, zonedInstant } from "./zoned.js"

/**
 * Budgets (plan sections 5.7 and 5.12). Every model call the tracker makes is charged to the
 * task's owner: one call and the CLI's cost estimate per run, plus recall's extraction calls for
 * a finding, which the host's Memory adapter charges with `charge`. Under the subscription the
 * dollar figures are the CLI's list-price estimate, not a bill, so the call ceilings are the hard
 * count. A day is a day in `BUDGET_ZONE`: at a ceiling a person's execute-lane tasks wait until
 * midnight Eastern, the person gets one DM and the admins are told once.
 *
 * A ceiling is reached when what was spent today is at or above it, checked before each run: a
 * run that starts under a dollar ceiling may end above it, and the next one waits. Reminders,
 * renewals and the price tracker make no model calls and never count.
 */

/** Budget days turn over at midnight in this zone (roshne, 2026-09-26, plan 5.7). */
export const BUDGET_ZONE = "America/New_York"

/** A ceiling per day; null means no ceiling of that kind. */
export interface BudgetLimits {
  usd: number | null
  calls: number | null
}

export interface BudgetPolicy {
  /** Each person's ceiling unless `personFor` says otherwise. */
  person: BudgetLimits
  /** Everyone's charges together. */
  global: BudgetLimits
  /** A person's own ceiling, when an admin raised it (plan 5.10); the host stores it. */
  personFor?: (user: User) => BudgetLimits | null | Promise<BudgetLimits | null>
}

/**
 * The decided defaults (plan 5.7, section 8 item 18): 2 USD and 20 model calls per person per
 * day; 10 USD and 100 model calls a day for everyone (the call count roshne's, 2026-09-28).
 */
export const DEFAULT_BUDGET: BudgetPolicy = {
  person: { usd: 2, calls: 20 },
  global: { usd: 10, calls: 100 },
}

export interface BudgetDay {
  /** `YYYY-MM-DD` in `BUDGET_ZONE`. */
  day: string
  /** Midnight that began it, as a UTC instant. */
  start: string
  /** The next midnight: when a paused person's tasks run again. */
  end: string
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

/** The budget day `now` falls in. */
export function budgetDay(now: Date): BudgetDay {
  const w = wallClock(now, BUDGET_ZONE)
  const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1))
  const start = zonedInstant(w.year, w.month, w.day, 0, 0, BUDGET_ZONE)
  const end = zonedInstant(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    BUDGET_ZONE,
  )
  return {
    day: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
    start: start.toISOString(),
    end: end.toISOString(),
  }
}

export interface Spent {
  usd: number
  calls: number
}

export function spent(rows: readonly Usage[]): Spent {
  return rows.reduce((s, r) => ({ usd: s.usd + r.costUsd, calls: s.calls + r.calls }), {
    usd: 0,
    calls: 0,
  })
}

/** Which ceiling `used` has reached, calls first since it is the hard count; null when neither. */
export function reached(used: Spent, limits: BudgetLimits): "calls" | "usd" | null {
  if (limits.calls !== null && used.calls >= limits.calls) return "calls"
  if (limits.usd !== null && used.usd >= limits.usd) return "usd"
  return null
}

export interface BudgetHold {
  scope: "person" | "global"
  limit: "calls" | "usd"
  used: Spent
  limits: BudgetLimits
  /** When the day turns over and the hold lifts. */
  until: string
  day: string
}

/**
 * Whether `owner` may start a model run now: null when both the global and the owner's ceilings
 * leave room, otherwise which one holds it. The global ceiling is checked first.
 */
export async function budgetHold(
  store: Store,
  policy: BudgetPolicy,
  owner: User,
  now: Date,
): Promise<BudgetHold | null> {
  const day = budgetDay(now)
  const window = { since: day.start, before: day.end }
  const all = await store.listUsage(window)
  const everyone = spent(all)
  const globalLimit = reached(everyone, policy.global)
  if (globalLimit) {
    return hold("global", globalLimit, everyone, policy.global, day)
  }
  const limits = (await policy.personFor?.(owner)) ?? policy.person
  const mine = spent(all.filter((u) => u.userId === owner.id))
  const personLimit = reached(mine, limits)
  return personLimit ? hold("person", personLimit, mine, limits, day) : null
}

function hold(
  scope: BudgetHold["scope"],
  limit: BudgetHold["limit"],
  used: Spent,
  limits: BudgetLimits,
  day: BudgetDay,
): BudgetHold {
  return { scope, limit, used, limits, until: day.end, day: day.day }
}

export interface Charge {
  userId: string
  occurrenceId?: string | null
  source: UsageSource
  calls: number
  costUsd?: number | null
  at: Date
}

/** Records a charge against a person's day. A host charges recall's extraction calls here. */
export async function charge(store: Store, c: Charge): Promise<Usage> {
  return store.addUsage({
    userId: c.userId,
    occurrenceId: c.occurrenceId ?? null,
    source: c.source,
    calls: c.calls,
    costUsd: c.costUsd ?? 0,
    at: c.at.toISOString(),
  })
}

function describeLimit(h: BudgetHold): string {
  return h.limit === "calls"
    ? `${h.limits.calls} model calls`
    : `${h.limits.usd} USD of model use (an estimate)`
}

/** The one DM a person gets on reaching their ceiling. */
export function budgetPersonMessage(h: BudgetHold): OutgoingMessage {
  return {
    text: [
      `You have reached today's limit of ${describeLimit(h)} for tasks that use the model.`,
      "They will run again after midnight Eastern time. Reminders are not affected.",
    ].join("\n"),
  }
}

/** What the admins are told when a person, or everyone, reaches a ceiling. */
export function budgetAdminMessage(h: BudgetHold, who: User | null): OutgoingMessage {
  const whom = h.scope === "global" ? "Everyone together has" : `${who?.displayName ?? who?.id} has`
  return {
    text: [
      `${whom} reached today's limit of ${describeLimit(h)} (${h.used.calls} calls, about ${h.used.usd.toFixed(2)} USD).`,
      "Tasks that use the model wait until midnight Eastern time; an admin can raise the limit.",
    ].join("\n"),
  }
}

/** What the admins are told once per usage window when the subscription's limit is hit. */
export function usageLimitAdminMessage(until: Date, parsed: boolean): OutgoingMessage {
  const when = parsed ? `until ${until.toISOString()}` : `for an hour (no reset time was given)`
  return {
    text: [
      "The Claude subscription's usage limit was reached.",
      `Tasks that use the model wait ${when}; nobody's budget is charged for it.`,
    ].join("\n"),
  }
}

/**
 * Sends `message` once for `key`, whatever the restarts: to `user` when given, and to every
 * admin. The key is claimed before sending, so a crash between claim and send loses the notice
 * rather than repeating it.
 */
export async function noticeOnce(
  store: Store,
  notifier: Notifier,
  key: string,
  now: Date,
  admins: OutgoingMessage,
  person?: { user: User; message: OutgoingMessage },
): Promise<boolean> {
  if (!(await store.claimNotice(key, now.toISOString()))) return false
  if (person) await notifier.sendDm(person.user.id, person.message)
  for (const admin of await store.listUsers({ admin: true })) {
    if (admin.id === person?.user.id) continue
    await notifier.sendDm(admin.id, admins)
  }
  return true
}
