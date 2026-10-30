import {
  defineTaskType,
  type Outcome,
  type ReplyContext,
  type RunContext,
} from "@rackbops/docket-core"

/**
 * Category 4 (plan section 1.2): "remind me to X at ..." and "every <cadence> remind me ...".
 * Notify lane, tier 0 only, `once` or `calendar`. The person answers done or snooze; a snooze
 * makes the dispatcher queue a new occurrence at the requested instant. Done on a one-off reminder
 * finishes the task, since nothing is left to remind of; on a recurring one it answers that run only.
 */

export interface ReminderConfig {
  /** What the reminder says. */
  text: string
}

export const DEFAULT_SNOOZE_MS = 60 * 60_000

/**
 * The snooze a reply asks for: `{ until }` as an instant, `{ minutes }`, or the default hour. An
 * `until` not after `now` would fire the reminder again at once (docket#60): it gets the default.
 */
export function snoozeUntil(payload: unknown, now: Date): Date {
  if (typeof payload === "object" && payload !== null) {
    const p = payload as { until?: unknown; minutes?: unknown }
    const until = typeof p.until === "string" ? Date.parse(p.until) : Number.NaN
    if (!Number.isNaN(until) && until > now.getTime()) return new Date(until)
    if (typeof p.minutes === "number" && Number.isFinite(p.minutes) && p.minutes > 0) {
      return new Date(now.getTime() + p.minutes * 60_000)
    }
  }
  return new Date(now.getTime() + DEFAULT_SNOOZE_MS)
}

export const reminder = defineTaskType<ReminderConfig>({
  id: "reminder",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["once", "calendar"],
  intake: {
    options: [
      { name: "text", description: "What to be reminded of", required: true, kind: "string" },
      {
        name: "at",
        description: "When, for a one-off reminder (an instant; the bot parses the person's words)",
        required: false,
        kind: "datetime",
      },
    ],
  },
  async run(ctx: RunContext<ReminderConfig>): Promise<Outcome> {
    return {
      notify: { text: ctx.config.text, actions: ["done", "snooze"] },
      summary: ctx.config.text,
    }
  },
  async onReply(ctx: ReplyContext<ReminderConfig>): Promise<Outcome> {
    if (ctx.reply.kind === "snooze") {
      const until = snoozeUntil(ctx.reply.payload, ctx.now)
      return { snoozeUntil: until, summary: `snoozed until ${until.toISOString()}` }
    }
    if (ctx.reply.kind === "done") {
      return ctx.task.schedule?.kind === "once"
        ? { complete: true, summary: "done" }
        : { summary: "done" }
    }
    return {}
  },
})
