import { ReplyRefusedError, RUN_KINDS, runRefusal } from "./answer.js"
import { optOut, respondToInvite } from "./consent.js"
import type { Outcome, RunContext, TaskType } from "./contract.js"
import { snoozeKey } from "./dedupe.js"
import { deliver } from "./delivery.js"
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
 */

const ME = "docket"
/** How many of the task's most recent series points a run sees. */
export const SERIES_IN_CONTEXT = 100

export interface LaneDeps {
  store: Store
  clock: Clock
  types: Readonly<Record<string, TaskType<unknown>>>
  notifier: Notifier
  /** Absent or null while no runner exists: the execute lane skips. */
  executor?: Executor | null
  /** Plain HTTP reads for the plain-code types; absent when the host offers none. */
  fetch?: Fetch | null
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

export class Lanes {
  constructor(private readonly d: LaneDeps) {}

  /** Work left running by a crash goes back to the queue; delivered events keep it from resending. */
  async recover(): Promise<string[]> {
    return this.d.store.requeueRunning()
  }

  async tickNotify(): Promise<TickResult> {
    const result: TickResult = { ran: 0, failed: 0, skipped: 0 }
    for (const occurrence of await this.due("notify")) {
      ;(await this.runOne(occurrence)) ? result.ran++ : result.failed++
    }
    return result
  }

  async tickExecute(): Promise<TickResult> {
    const due = await this.due("execute")
    if (!this.d.executor) return { ran: 0, failed: 0, skipped: due.length }
    const result: TickResult = { ran: 0, failed: 0, skipped: 0 }
    for (const occurrence of due) {
      const outcome = await this.runOne(occurrence)
      if (outcome === null) {
        result.skipped += due.length - result.ran - result.failed
        break
      }
      outcome ? result.ran++ : result.failed++
    }
    return result
  }

  /**
   * Routes a reply to the task: consent replies here, the rest to the type. A run's done, snooze
   * or decision is the owner's, once per run (`runRefusal`); anything else throws
   * `ReplyRefusedError` and stores nothing. Text from any recipient routes to the type.
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
    return {
      task: loaded.task,
      occurrence,
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

  /** True on success, false on failure, null when the executor was unavailable (item requeued). */
  private async runOne(occurrence: Occurrence): Promise<boolean | null> {
    const { store, clock } = this.d
    const task = await store.getTask(occurrence.taskId)
    if (!task) return this.fail(occurrence, `no task ${occurrence.taskId}`)
    const loaded = await this.load(task)
    if ("error" in loaded) return this.fail(occurrence, loaded.error)
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
      await store.updateOccurrence(occurrence.id, {
        status: "done",
        finishedAt: clock.now().toISOString(),
        summary: outcome.summary ?? null,
        costUsd,
      })
      if (outcome.complete) await this.complete(task, null, clock.now())
      else await this.next(task, loaded.owner)
      return true
    } catch (err) {
      if (err instanceof ExecutorUnavailableError) {
        await this.event(occurrence, "status", `waiting: ${err.message}`)
        await store.updateOccurrence(occurrence.id, { status: "queued" })
        return null
      }
      await this.fail(occurrence, err instanceof Error ? err.message : String(err))
      await this.next(task, loaded.owner)
      return false
    }
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

  private async fail(occurrence: Occurrence, message: string): Promise<false> {
    await this.event(occurrence, "error", message)
    await this.d.store.updateOccurrence(occurrence.id, {
      status: "failed",
      finishedAt: this.d.clock.now().toISOString(),
      error: message,
    })
    return false
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
