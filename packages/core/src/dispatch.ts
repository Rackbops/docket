import { ReplyRefusedError, RUN_KINDS, runRefusal } from "./answer.js"
import {
  type BudgetPolicy,
  budgetAdminMessage,
  budgetHold,
  budgetPersonMessage,
  charge,
  DEFAULT_BUDGET,
  noticeOnce,
  usageLimitAdminMessage,
} from "./budget.js"
import { optOut, respondToInvite } from "./consent.js"
import type { Outcome, RunContext, TaskType } from "./contract.js"
import { SNOOZE_PREFIX, snoozeKey } from "./dedupe.js"
import { deliver } from "./delivery.js"
import type { JobResult } from "./job.js"
import type { Lane } from "./lanes.js"
import type { Occurrence, Reply, ReplyKind, Task, User } from "./model.js"
import {
  type Clock,
  type Executor,
  ExecutorUnavailableError,
  type Fetch,
  type Notifier,
  type Store,
} from "./ports.js"
import { isLate, materialize } from "./scheduler.js"

/**
 * The two lanes (plan section 5.3). `tickNotify` runs every due notify-lane occurrence and never
 * waits on a model; `tickExecute` runs due execute-lane occurrences one at a time through the
 * Executor. A lane whose runtime is missing is skipped -- its items stay queued -- and never ends
 * the other lane's drain, which is the starvation city-hall's single drain had (city-hall#7).
 *
 * The dispatcher owns status and applies what a type's Outcome asks for: state is stored on
 * the task, series points are appended, `complete` finishes the task. A failed run still
 * materializes the schedule's next occurrence, so one bad fetch or one closed DM never ends a
 * recurring task on its own.
 *
 * The execute lane charges every model run to the task's owner and holds a run whose owner, or
 * everyone together, has reached a daily ceiling (plan 5.7, `budget.ts`); the item stays queued
 * and runs after midnight Eastern. A run that hits the subscription's usage limit is the third
 * outcome (5.12): it is requeued, charged to nobody, the admins are told once per window, and
 * the lane waits until the reset the CLI named, or an hour.
 */

const ME = "docket"
/** How many of the task's most recent series points a run sees. */
export const SERIES_IN_CONTEXT = 100
/** How long the execute lane waits after a usage limit whose reset it could not read. */
export const USAGE_LIMIT_BACKOFF_MS = 3_600_000

export interface LaneDeps {
  store: Store
  clock: Clock
  types: Readonly<Record<string, TaskType<unknown>>>
  notifier: Notifier
  /** Absent or null while no runner exists: the execute lane skips. */
  executor?: Executor | null
  /** Plain HTTP reads for the plain-code types; absent when the host offers none. */
  fetch?: Fetch | null
  /** Daily ceilings for model runs; `DEFAULT_BUDGET` when absent. */
  budget?: BudgetPolicy
}

export interface TickResult {
  ran: number
  failed: number
  /** Due items left queued because their lane has no runtime. */
  skipped: number
}

export interface ReplyInput {
  taskId: string
  occurrenceId: string | null
  userId: string
  kind: ReplyKind
  payload: unknown
}

interface Loaded {
  task: Task
  type: TaskType<unknown>
  owner: User
  recipients: User[]
}

/** How one item went: run, failed, held for its owner's budget, or the lane must stop. */
type Verdict = "ran" | "failed" | "held" | "stop"

/** The subscription's usage window is spent (plan 5.12); the lane waits until `until`. */
class UsageLimitReached extends Error {
  constructor(
    readonly until: Date,
    readonly parsed: boolean,
  ) {
    super(`usage limit until ${until.toISOString()}`)
  }
}

export class Lanes {
  /**
   * After a usage limit, the execute lane runs nothing before this instant. In memory: after a
   * restart the next run meets the limit again and sets it again, which costs one call attempt.
   */
  private executeAfter: Date | null = null

  constructor(private readonly d: LaneDeps) {}

  /** Work left running by a crash goes back to the queue; delivered events keep it from resending. */
  async recover(): Promise<string[]> {
    return this.d.store.requeueRunning()
  }

  async tickNotify(): Promise<TickResult> {
    const result: TickResult = { ran: 0, failed: 0, skipped: 0 }
    for (const occurrence of await this.due("notify")) {
      ;(await this.runOne(occurrence)) === "ran" ? result.ran++ : result.failed++
    }
    return result
  }

  async tickExecute(): Promise<TickResult> {
    const due = await this.due("execute")
    if (!this.d.executor) return { ran: 0, failed: 0, skipped: due.length }
    if (this.executeAfter && this.d.clock.now() < this.executeAfter) {
      return { ran: 0, failed: 0, skipped: due.length }
    }
    const result: TickResult = { ran: 0, failed: 0, skipped: 0 }
    for (const [i, occurrence] of due.entries()) {
      const verdict = await this.runOne(occurrence)
      if (verdict === "stop") {
        result.skipped += due.length - i
        break
      }
      if (verdict === "held") result.skipped++
      else verdict === "ran" ? result.ran++ : result.failed++
    }
    return result
  }

  /**
   * Routes a reply to the task: consent replies here, the rest to the type. A run's done, snooze
   * or decision is the owner's, once per run (`runRefusal`); anything else throws
   * `ReplyRefusedError` and stores nothing. Text is stored whoever sends it -- the host gates who
   * may reply -- and routed to the type when the task is active and the reply names a run; no
   * type acts on text today. "Once" holds when the host handles one task's replies one
   * at a time; two truly concurrent answers can both pass (a snooze still queues one run). A run
   * reply names its run, so a host's `/task done <task>` has to pick one (the latest fired).
   */
  async reply(input: ReplyInput): Promise<Outcome | null> {
    const { store } = this.d
    const now = this.d.clock.now()
    const task = await store.getTask(input.taskId)
    if (!task) throw new Error(`no task ${input.taskId}`)
    if (input.kind === "accept" || input.kind === "decline") {
      await respondToInvite(store, task, input.userId, input.kind, now, input.occurrenceId)
      return null
    }
    if (input.kind === "opt_out") {
      await optOut(store, task, input.userId, now, input.occurrenceId)
      return null
    }
    if (RUN_KINDS.has(input.kind)) {
      const refusal = await runRefusal(store, task, input.occurrenceId, input.userId)
      if (refusal) throw new ReplyRefusedError(refusal)
    }
    const reply = await store.addReply({ ...input, at: now.toISOString() })
    // A text reply to a paused, done or archived task is kept as history, never acted on.
    if (task.status !== "active") return null
    const loaded = await this.load(task)
    if ("error" in loaded || !loaded.type.onReply) return null
    const occurrence = input.occurrenceId ? await store.getOccurrence(input.occurrenceId) : null
    if (!occurrence) return null
    const ctx = await this.context(loaded, occurrence, now)
    const outcome = await loaded.type.onReply({ ...ctx, reply })
    await this.apply(task, outcome, now)
    if (outcome.complete) await this.complete(task, input.userId, now)
    else if (outcome.snoozeUntil) {
      await this.snooze(task, occurrence, outcome.snoozeUntil, reply, now)
    }
    return outcome
  }

  private async due(lane: Lane): Promise<Occurrence[]> {
    return this.d.store.listOccurrences({
      lane,
      status: "queued",
      dueBefore: this.d.clock.now().toISOString(),
    })
  }

  private async load(task: Task): Promise<Loaded | { error: string }> {
    const type = this.d.types[task.type]
    if (!type) return { error: `no task type ${task.type}` }
    const owner = await this.d.store.getUser(task.ownerId)
    if (!owner) return { error: `no owner ${task.ownerId}` }
    const recipients: User[] = []
    for (const r of await this.d.store.listRecipients(task.id)) {
      if (r.state !== "accepted") continue
      const user = await this.d.store.getUser(r.userId)
      if (user) recipients.push(user)
    }
    return { task, type, owner, recipients }
  }

  private async context(
    loaded: Loaded,
    occurrence: Occurrence,
    now: Date,
  ): Promise<RunContext<unknown>> {
    const originalDueAt = await this.originalDueAt(occurrence)
    return {
      task: loaded.task,
      occurrence,
      ...(originalDueAt ? { originalDueAt } : {}),
      owner: loaded.owner,
      recipients: loaded.recipients,
      config: loaded.task.config,
      state: loaded.task.state,
      now,
      ports: this.d.fetch ? { fetch: this.d.fetch } : {},
      history: {
        events: await this.d.store.listEvents(occurrence.id),
        replies: await this.d.store.listReplies(loaded.task.id),
        series: await this.d.store.listSeries(loaded.task.id, { limit: SERIES_IN_CONTEXT }),
      },
    }
  }

  /** The due instant of the run a snooze run re-asks, back through any chain of snoozes. */
  private async originalDueAt(occurrence: Occurrence): Promise<string | null> {
    let current = occurrence
    let found: string | null = null
    // Bounded, so a store that ever handed back a cycle cannot hang a run.
    for (let hops = 0; hops < 100 && current.dedupeKey.startsWith(SNOOZE_PREFIX); hops++) {
      const from = await this.d.store.getOccurrence(current.dedupeKey.slice(SNOOZE_PREFIX.length))
      if (!from) break
      found = from.dueAt
      current = from
    }
    return found
  }

  /** Stores what the outcome carries for the task: new state, series points. */
  private async apply(task: Task, outcome: Outcome, now: Date): Promise<void> {
    const { store } = this.d
    if (outcome.state !== undefined) {
      await store.updateTask(task.id, { state: outcome.state, at: now.toISOString() })
    }
    for (const point of outcome.series ?? []) {
      await store.addSeriesPoint({
        taskId: task.id,
        at: point.at ?? now.toISOString(),
        value: point.value,
        unit: point.unit ?? null,
        note: point.note ?? null,
      })
    }
  }

  /** The type said the task is finished: no more occurrences, status done, on record. */
  private async complete(task: Task, actorId: string | null, now: Date): Promise<void> {
    const { store } = this.d
    const at = now.toISOString()
    await store.deleteQueuedOccurrences(task.id)
    await store.updateTask(task.id, { status: "done", at })
    await store.addTaskEvent({ taskId: task.id, actorId, kind: "completed", detail: "", at })
  }

  /**
   * Runs one due item. `held` and `stop` leave it queued: `held` when its owner is at a ceiling
   * (the lane goes on to other owners), `stop` when nothing else in the lane can run either --
   * the executor is unavailable, everyone is at the global ceiling, or the usage limit was hit.
   */
  private async runOne(occurrence: Occurrence): Promise<Verdict> {
    const { store, clock } = this.d
    const task = await store.getTask(occurrence.taskId)
    if (!task) return this.fail(occurrence, `no task ${occurrence.taskId}`)
    const loaded = await this.load(task)
    if ("error" in loaded) return this.fail(occurrence, loaded.error)
    if (loaded.type.lane === "execute") {
      const held = await this.budgetCheck(loaded.owner)
      if (held) return held
    }
    const now = clock.now()
    const late = isLate(occurrence, now)
    await store.updateOccurrence(occurrence.id, {
      status: "running",
      startedAt: now.toISOString(),
      late,
      error: null,
    })
    await this.event(occurrence, "status", late ? "started late" : "started")
    try {
      const ctx = await this.context(loaded, occurrence, now)
      const { outcome, costUsd } = await this.execute(loaded.type, ctx, occurrence)
      await this.apply(task, outcome, clock.now())
      if (outcome.notify) {
        await deliver(
          store,
          this.d.notifier,
          occurrence,
          [loaded.owner, ...loaded.recipients],
          outcome.notify,
          () => clock.now(),
        )
      }
      // The owner may have snoozed this run while the rest were still being sent; keep that.
      const snoozed = (await store.getOccurrence(occurrence.id))?.status === "snoozed"
      await store.updateOccurrence(occurrence.id, {
        status: snoozed ? "snoozed" : "done",
        finishedAt: clock.now().toISOString(),
        summary: outcome.summary ?? null,
        costUsd,
      })
      if (outcome.complete) await this.complete(task, null, clock.now())
      else await this.next(task, loaded.owner)
      return "ran"
    } catch (err) {
      if (err instanceof ExecutorUnavailableError || err instanceof UsageLimitReached) {
        await this.event(occurrence, "status", `waiting: ${err.message}`)
        await store.updateOccurrence(occurrence.id, { status: "queued" })
        if (err instanceof UsageLimitReached) await this.usageLimit(err)
        return "stop"
      }
      await this.fail(occurrence, err instanceof Error ? err.message : String(err))
      await this.next(task, loaded.owner)
      return "failed"
    }
  }

  /** `held` or `stop` when a ceiling keeps the owner's run from starting; the notices go once. */
  private async budgetCheck(owner: User): Promise<Verdict | null> {
    const { store, notifier, clock } = this.d
    const now = clock.now()
    const hold = await budgetHold(store, this.d.budget ?? DEFAULT_BUDGET, owner, now)
    if (!hold) return null
    if (hold.scope === "global") {
      await noticeOnce(
        store,
        notifier,
        `budget:global:${hold.day}`,
        now,
        budgetAdminMessage(hold, null),
      )
      return "stop"
    }
    await noticeOnce(
      store,
      notifier,
      `budget:person:${owner.id}:${hold.day}`,
      now,
      budgetAdminMessage(hold, owner),
      { user: owner, message: budgetPersonMessage(hold) },
    )
    return "held"
  }

  private async usageLimit(err: UsageLimitReached): Promise<void> {
    const { store, notifier, clock } = this.d
    this.executeAfter = err.until
    const key = `usage-limit:${err.until.toISOString()}`
    await noticeOnce(
      store,
      notifier,
      key,
      clock.now(),
      usageLimitAdminMessage(err.until, err.parsed),
    )
  }

  /** The run's charge to its owner: one call and its estimate. A usage limit charges nobody. */
  private async chargeRun(occurrence: Occurrence, ownerId: string, result: JobResult) {
    if (result.kind === "usage_limit") {
      const reset = result.resetsAt ? new Date(result.resetsAt) : null
      const now = this.d.clock.now()
      if (reset && !Number.isNaN(reset.getTime()) && reset > now) {
        throw new UsageLimitReached(reset, true)
      }
      throw new UsageLimitReached(new Date(now.getTime() + USAGE_LIMIT_BACKOFF_MS), false)
    }
    if (result.kind === "auth_failed") return
    await charge(this.d.store, {
      userId: ownerId,
      occurrenceId: occurrence.id,
      source: "run",
      calls: 1,
      costUsd: result.totalCostUsd ?? null,
      at: this.d.clock.now(),
    })
  }

  /** The schedule's next occurrence, from the task as it now is (a run may have ended it). */
  private async next(task: Task, owner: User): Promise<void> {
    const current = await this.d.store.getTask(task.id)
    if (current) await materialize(this.d.store, current, owner, this.d.clock.now())
  }

  private async execute(
    type: TaskType<unknown>,
    ctx: RunContext<unknown>,
    occurrence: Occurrence,
  ): Promise<{ outcome: Outcome; costUsd: number | null }> {
    if (type.lane === "notify") {
      if (!type.run) throw new Error(`${type.id} has no run`)
      return { outcome: await type.run(ctx), costUsd: null }
    }
    if (!type.prepare || !type.finish) throw new Error(`${type.id} has no prepare/finish`)
    if (!this.d.executor) throw new ExecutorUnavailableError("no executor configured")
    const spec = await type.prepare(ctx)
    const result = await this.d.executor.run(spec, occurrence.id)
    await this.chargeRun(occurrence, ctx.owner.id, result)
    const outcome = await type.finish(ctx, result)
    return { outcome, costUsd: result.totalCostUsd ?? null }
  }

  private async snooze(
    task: Task,
    occurrence: Occurrence,
    until: Date,
    reply: Reply,
    now: Date,
  ): Promise<void> {
    const { store } = this.d
    await store.updateOccurrence(occurrence.id, { status: "snoozed" })
    await this.event(
      occurrence,
      "status",
      `snoozed until ${until.toISOString()} by ${reply.userId}`,
    )
    await store.createOccurrence({
      taskId: task.id,
      lane: task.lane,
      dueAt: until.toISOString(),
      dedupeKey: snoozeKey(occurrence.id),
      at: now.toISOString(),
    })
  }

  private async fail(occurrence: Occurrence, message: string): Promise<"failed"> {
    await this.event(occurrence, "error", message)
    // A snooze the owner pressed while the rest were being sent stands, as in runOne.
    const snoozed = (await this.d.store.getOccurrence(occurrence.id))?.status === "snoozed"
    await this.d.store.updateOccurrence(occurrence.id, {
      status: snoozed ? "snoozed" : "failed",
      finishedAt: this.d.clock.now().toISOString(),
      error: message,
    })
    return "failed"
  }

  private async event(
    occurrence: Occurrence,
    type: "status" | "error",
    text: string,
  ): Promise<void> {
    await this.d.store.addEvent({
      occurrenceId: occurrence.id,
      agent: ME,
      type,
      text,
      at: this.d.clock.now().toISOString(),
    })
  }
}
