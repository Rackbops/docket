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
import {
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicy,
  deliver,
  dropOwed,
  freshRoundForPause,
  settleStaleClaims,
} from "./delivery.js"
import type { JobResult } from "./job.js"
import type { Lane } from "./lanes.js"
import type {
  Delivery,
  Occurrence,
  Reply,
  ReplyKind,
  RunRecord,
  Task,
  TaskStatus,
  User,
} from "./model.js"
import {
  type Clock,
  type Executor,
  ExecutorUnavailableError,
  type Fetch,
  type Notifier,
  type Store,
} from "./ports.js"
import { hasFired, isFinishing, parseRunRecord } from "./record.js"
import { isLate, materialize } from "./scheduler.js"

/**
 * The two lanes (plan section 5.3). `tickNotify` runs every due notify-lane occurrence and never
 * waits on a model; `tickExecute` runs due execute-lane occurrences one at a time through the
 * Executor. A lane whose runtime is missing is skipped -- its items stay queued -- and never ends
 * the other lane's drain, which is the starvation city-hall's single drain had (city-hall#7).
 *
 * The dispatcher owns status and applies what a type's Outcome asks for: state is stored on
 * the task, series points are appended, `complete` finishes the task. A failed run still
 * materializes the schedule's next occurrence, so one bad fetch never ends a recurring task on its
 * own. Only an active task's runs are taken, and each is re-checked and started by a
 * compare-and-set (`updateOccurrenceIf`), so a paused task never runs and no run starts twice.
 *
 * **The order of a run, so a failed send is retried without running the type twice or losing an
 * alert** (plan 5.5, item 58). A type's outcome carries both the state that remembers what it
 * saw (a price's crossing, a miss count) and the message about it, so storing one without the
 * other loses something: state first and a failed DM is never retried (the next run sees no
 * crossing); DM first and a crash before the state is stored runs the type again. So a run goes:
 *
 * 1. the type runs (on the execute lane: prepare, the Executor, the charge, finish);
 * 2. the tick's signal is checked: an aborted tick drops the outcome before anything is stored
 *    and the run goes back to the queue unstarted, so the one outcome that counts is the next
 *    tick's;
 * 3. **the run fires**: its outcome is recorded on the occurrence (`Occurrence.record`). From here
 *    the type never runs for it again;
 * 4. the schedule's next run is materialized at once, so nothing owed by this one holds up the
 *    schedule;
 * 5. the outcome is applied (state, then series points keyed by the run, so applying twice adds
 *    nothing) and the record marked applied;
 * 6. one delivery row is planned per person it goes to -- the owner and accepted recipients; for
 *    a snooze's run the owner alone, since a snooze re-asks the owner -- and the run is marked
 *    done;
 * 7. it is delivered (`delivery.ts`). What cannot go out now stays owed on its row and is retried
 *    by later notify ticks with a backoff, from the recorded message: owed delivery is the notify
 *    side's work, whichever lane the run was on, so it never waits on a model or a runner.
 *
 * A Store error during steps 4 to 6 puts the fired run back in the queue, and the next notify tick
 * resumes it from the record (`resume`) before it starts anything new, at most `MAX_RESUMES`
 * times; then it is marked done with the error on record, never failed -- the type did not fail.
 * A crash anywhere after step 3 resumes the same way from `recover()`, which also settles any
 * claim left mid-send as unconfirmed; a fired run left `running` past `STALE_RUN_MS` without a
 * restart (its tick died on a Store error) is put back by a later notify tick. While a run is
 * finishing (`isFinishing`), its task's next run waits, on either lane, so it never runs on state
 * the outcome has not yet written, and the run cannot be answered. A paused or archived task's
 * fired run is still applied, but its sends stay owed (`deliverOwed` holds or drops them).
 *
 * Two losses remain, both on a crash or Store error in a narrow window. Between the Executor's
 * answer and step 3, a crash re-runs the Job on restart: that is a second model call, and it is
 * charged as one. A Store error writing the record itself (step 3) fails the run: the outcome is
 * lost, and on the execute lane so is the model call it cost, which stays charged; the schedule's
 * next run follows as after any failure.
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
/** The longest the execute lane waits on one usage limit before trying again. */
export const MAX_USAGE_LIMIT_WAIT_MS = 86_400_000
/** The subscription's rolling window (plan 5.12), for keying a notice with no reset time. */
const USAGE_WINDOW_MS = 5 * 3_600_000

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
  /** Retries, backoff and limits for owed sends; `DEFAULT_DELIVERY_POLICY` when absent. */
  delivery?: DeliveryPolicy
}

export interface TickResult {
  /** Runs that fired, or fired runs this tick finished. Owed sends are not counted here. */
  ran: number
  failed: number
  /** Due items left queued: their lane has no runtime, a ceiling holds them, or the tick aborted. */
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

/**
 * How one item went: run, failed, left for later (`held`: its owner's budget, or it was no longer
 * due when re-checked), or the lane must stop.
 */
type Verdict = "ran" | "failed" | "held" | "stop"

/** Times a fired run's remaining steps are retried after a Store error before it is given up. */
export const MAX_RESUMES = 3

/** A fired run still `running` this long after it (re)started is taken to have lost its tick. */
export const STALE_RUN_MS = 10 * 60_000

/** The subscription's usage window is spent (plan 5.12); the lane waits until `until`. */
class UsageLimitReached extends Error {
  constructor(
    readonly until: Date,
    readonly parsed: boolean,
    /** Names the usage window, so its notice goes once however often the lane retries. */
    readonly window: string,
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

  /**
   * On start: work left running by a crash goes back to the queue unstarted (a fired run resumes
   * from its record), and every claim left mid-send is settled unconfirmed, never resent.
   */
  async recover(): Promise<string[]> {
    const ids = await this.d.store.requeueRunning()
    await settleStaleClaims(this.d.store, this.d.clock.now(), true)
    return ids
  }

  /**
   * The notify tick: fired runs of either lane left part way (after putting back any whose tick
   * died), then every due notify-lane run, then the sends still owed. Finishing first means a
   * task's next run reads the state its last one wrote. With a signal (the host's tick), nothing
   * new starts once it has aborted: it is checked before each run, before an outcome is stored,
   * and before each send, so an abort leaves the rest for the next tick and never runs a type
   * twice (the order above). A Store error on one run is counted as a failure of that run and
   * never stops the tick.
   */
  async tickNotify(signal?: AbortSignal): Promise<TickResult> {
    const result: TickResult = { ran: 0, failed: 0, skipped: 0 }
    const count = (verdict: Verdict) => {
      if (verdict === "stop" || verdict === "held") result.skipped++
      else verdict === "ran" ? result.ran++ : result.failed++
    }
    await this.guarded(() => this.sweepStaleRuns())
    for (const occurrence of await this.unfinished()) {
      if (signal?.aborted) return result
      count(await this.guarded(() => this.resume(occurrence, signal)))
    }
    // Listed after the resumes, so a task whose last run just finished runs on its new state.
    const due = await this.due("notify")
    for (const [i, occurrence] of due.entries()) {
      if (signal?.aborted) {
        result.skipped += due.length - i
        return result
      }
      count(await this.guarded(() => this.runOne(occurrence, signal)))
    }
    if (!signal?.aborted) await this.guarded(() => this.deliverOwed(signal))
    return result
  }

  /** Runs `step`; a thrown Store error becomes a failed item, so the tick goes on. */
  private async guarded<T>(step: () => Promise<T>): Promise<T | "failed"> {
    try {
      return await step()
    } catch {
      return "failed"
    }
  }

  /**
   * Fired runs still `running` long after they (re)started: their tick died on a Store error
   * past the record, with no restart to requeue them. Each goes back to the queue to resume,
   * compare-and-set, so a run that is only slow finishes as usual (its own last write then finds
   * it moved and leaves it to the resume).
   */
  private async sweepStaleRuns(): Promise<void> {
    const { store, clock } = this.d
    const cutoff = new Date(clock.now().getTime() - STALE_RUN_MS).toISOString()
    for (const o of await store.listOccurrences({ status: "running" })) {
      if (!hasFired(o) || (o.startedAt ?? "") > cutoff) continue
      await store.updateOccurrenceIf(o.id, "running", { status: "queued", startedAt: null })
    }
  }

  /** The execute tick: due model runs only. What a fired run still owes goes out on the notify tick. */
  async tickExecute(): Promise<TickResult> {
    // No signal here: an execute-lane outcome cost a model call, so it is recorded, never dropped.
    const due = await this.due("execute")
    if (!this.d.executor) return { ran: 0, failed: 0, skipped: due.length }
    if (this.executeAfter && this.d.clock.now() < this.executeAfter) {
      return { ran: 0, failed: 0, skipped: due.length }
    }
    const result: TickResult = { ran: 0, failed: 0, skipped: 0 }
    for (const [i, occurrence] of due.entries()) {
      const verdict = await this.guarded(() => this.runOne(occurrence))
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
    await this.apply(task, outcome, now, null)
    if (outcome.complete) await this.complete(task, input.userId, now)
    else if (outcome.snoozeUntil) {
      await this.snooze(task, occurrence, outcome.snoozeUntil, reply, now)
    }
    return outcome
  }

  /**
   * The lane's due runs that have not fired, whose task is active. A paused, done or archived
   * task's runs are left queued, never run; a run whose task is gone is kept, so it fails with
   * the reason on record.
   */
  private async due(lane: Lane): Promise<Occurrence[]> {
    const queued = await this.d.store.listOccurrences({
      lane,
      status: "queued",
      dueBefore: this.d.clock.now().toISOString(),
    })
    const status = new Map<string, TaskStatus | null>()
    const kept: Occurrence[] = []
    for (const o of queued) {
      if (hasFired(o)) continue
      if (!status.has(o.taskId)) {
        status.set(o.taskId, (await this.d.store.getTask(o.taskId))?.status ?? null)
      }
      const s = status.get(o.taskId)
      if (s === null || s === "active") kept.push(o)
    }
    return kept
  }

  /** Fired runs of either lane put back in the queue part way (a Store error, a crash). */
  private async unfinished(): Promise<Occurrence[]> {
    const queued = await this.d.store.listOccurrences({
      status: "queued",
      dueBefore: this.d.clock.now().toISOString(),
    })
    return queued.filter(isFinishing)
  }

  /** The owner and accepted recipients: who a run of `task` goes to. */
  private async audience(task: Task): Promise<{ owner: User; recipients: User[] } | null> {
    const owner = await this.d.store.getUser(task.ownerId)
    if (!owner) return null
    const recipients: User[] = []
    for (const r of await this.d.store.listRecipients(task.id)) {
      if (r.state !== "accepted") continue
      const user = await this.d.store.getUser(r.userId)
      if (user) recipients.push(user)
    }
    return { owner, recipients }
  }

  private async load(task: Task): Promise<Loaded | { error: string }> {
    const type = this.d.types[task.type]
    if (!type) return { error: `no task type ${task.type}` }
    const people = await this.audience(task)
    if (!people) return { error: `no owner ${task.ownerId}` }
    return { task, type, ...people }
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

  /**
   * Stores what the outcome carries for the task: new state, series points. A run's points are
   * keyed `<occurrence>:<index>`, so applying one outcome twice appends nothing twice.
   */
  private async apply(
    task: Task,
    outcome: Omit<Outcome, "snoozeUntil">,
    now: Date,
    occurrenceId: string | null,
  ): Promise<void> {
    const { store } = this.d
    if (outcome.state !== undefined) {
      await store.updateTask(task.id, { state: outcome.state, at: now.toISOString() })
    }
    for (const [i, point] of (outcome.series ?? []).entries()) {
      await store.addSeriesPoint({
        taskId: task.id,
        at: point.at ?? now.toISOString(),
        value: point.value,
        unit: point.unit ?? null,
        note: point.note ?? null,
        key: occurrenceId === null ? null : `${occurrenceId}:${i}`,
      })
    }
  }

  /**
   * The type said the task is finished: no more occurrences, status done, on record. A queued run
   * that has not fired is dropped; a fired one is kept, to finish, and what any run still owes
   * its recipients goes on being sent.
   */
  private async complete(task: Task, actorId: string | null, now: Date): Promise<void> {
    const { store } = this.d
    const at = now.toISOString()
    for (const o of await store.listOccurrences({ taskId: task.id, status: "queued" })) {
      if (!hasFired(o)) await store.deleteOccurrence(o.id)
    }
    await store.updateTask(task.id, { status: "done", at })
    await store.addTaskEvent({ taskId: task.id, actorId, kind: "completed", detail: "", at })
  }

  /**
   * Runs one due item (the order is in the header). `held` and `stop` leave it queued: `held`
   * when its owner is at a ceiling (the lane goes on to other owners) or it is no longer due when
   * re-checked, `stop` when nothing else in the lane can run either -- the executor is
   * unavailable, everyone is at the global ceiling, the usage limit was hit, or the tick aborted.
   */
  private async runOne(occurrence: Occurrence, signal?: AbortSignal): Promise<Verdict> {
    const { store, clock } = this.d
    const task = await store.getTask(occurrence.taskId)
    if (!task) return this.fail(occurrence, `no task ${occurrence.taskId}`)
    // Re-checked: the task may have been paused since the lane listed its due runs.
    if (task.status !== "active") return "held"
    // A run of this task still finishing has not written its state yet: this one waits.
    if (await this.finishing(task.id, occurrence.id)) return "held"
    const loaded = await this.load(task)
    if ("error" in loaded) return this.fail(occurrence, loaded.error)
    if (loaded.type.lane === "execute") {
      const held = await this.budgetCheck(loaded.owner)
      if (held) return held
    }
    const now = clock.now()
    const late = isLate(occurrence, now)
    // Started only if it is still queued: another tick, a reply or a reschedule may have moved it.
    const started = await store.updateOccurrenceIf(occurrence.id, "queued", {
      status: "running",
      startedAt: now.toISOString(),
      late,
      error: null,
    })
    if (!started || hasFired(started)) return "held"
    let record: RunRecord
    try {
      await this.event(occurrence, "status", late ? "started late" : "started")
      const ctx = await this.context(loaded, started, now)
      const { outcome, costUsd } = await this.execute(loaded.type, ctx, started)
      if (signal?.aborted) {
        await this.requeue(started, "the tick was aborted before the outcome was stored")
        return "stop"
      }
      const { snoozeUntil: _replyOnly, ...kept } = outcome
      record = {
        outcome: kept,
        costUsd,
        firedAt: clock.now().toISOString(),
        appliedAt: null,
        resumes: 0,
      }
      await store.updateOccurrence(started.id, { record })
    } catch (err) {
      if (err instanceof ExecutorUnavailableError || err instanceof UsageLimitReached) {
        await this.requeue(started, err.message)
        if (err instanceof UsageLimitReached) await this.usageLimit(err)
        return "stop"
      }
      await this.fail(started, err instanceof Error ? err.message : String(err))
      await this.next(task, loaded.owner)
      return "failed"
    }
    return this.finishFired({ ...started, record }, task, record, signal)
  }

  /** Back to the queue unstarted: nothing of this attempt was stored, so it runs afresh. */
  private async requeue(occurrence: Occurrence, why: string): Promise<void> {
    await this.event(occurrence, "status", `waiting: ${why}`)
    await this.d.store.updateOccurrence(occurrence.id, { status: "queued", startedAt: null })
  }

  /** A fired run put back part way: its remaining steps, from its record. The type never runs. */
  private async resume(occurrence: Occurrence, signal?: AbortSignal): Promise<Verdict> {
    const { store, clock } = this.d
    const started = await store.updateOccurrenceIf(occurrence.id, "queued", {
      status: "running",
      startedAt: clock.now().toISOString(),
    })
    if (!started) return "held"
    const record = parseRunRecord(started.record)
    const task = await store.getTask(started.taskId)
    if (!record || !task) {
      const error = record ? `no task ${started.taskId}` : "the run's record could not be read"
      await this.event(started, "error", error)
      await store.updateOccurrence(started.id, {
        status: "done",
        finishedAt: clock.now().toISOString(),
        error,
      })
      await dropOwed(
        store,
        await store.listDeliveries({ occurrenceId: started.id }),
        error,
        clock.now(),
      )
      return "failed"
    }
    await this.event(started, "status", "resumed")
    return this.finishFired(started, task, record, signal)
  }

  /**
   * Steps 4 to 7 of a fired run (the header). Resumable: each step is idempotent or marked done
   * on the record, so a run put back after a Store error picks up where it stopped.
   */
  private async finishFired(
    occurrence: Occurrence,
    task: Task,
    record: RunRecord,
    signal?: AbortSignal,
  ): Promise<Verdict> {
    const { store, clock } = this.d
    const { outcome } = record
    let people: { owner: User; recipients: User[] } | null = null
    let current: Task | null = null
    try {
      people = await this.audience(task)
      if (people && !outcome.complete) await this.next(task, people.owner)
      if (record.appliedAt === null) {
        await this.apply(task, outcome, new Date(record.firedAt), occurrence.id)
        const applied = { ...record, appliedAt: clock.now().toISOString() }
        await store.updateOccurrence(occurrence.id, { record: applied })
        record = applied
      }
      if (outcome.notify && people) {
        const at = clock.now().toISOString()
        // A snooze's run re-asks the owner; recipients had their copy of the run it re-asks.
        const snoozeRun = occurrence.dedupeKey.startsWith(SNOOZE_PREFIX)
        const to = snoozeRun ? [people.owner] : [people.owner, ...people.recipients]
        for (const u of to) await store.planDelivery(occurrence.id, u.id, at)
      }
      // Compare-and-set: if a sweep put the run back meanwhile, its resume finishes it.
      const done = await store.updateOccurrenceIf(occurrence.id, "running", {
        status: "done",
        finishedAt: clock.now().toISOString(),
        summary: outcome.summary ?? null,
        costUsd: record.costUsd,
        error: people ? null : `no owner ${task.ownerId}`,
      })
      if (!done) return "held"
      current = await store.getTask(task.id)
      if (outcome.complete && current && current.status !== "done") {
        await this.complete(current, null, clock.now())
        current = await store.getTask(task.id)
      }
    } catch (err) {
      return this.putBack(occurrence, record, err)
    }
    // A paused or archived task's sends stay owed: `deliverOwed` holds or drops them.
    const sending = current?.status === "active" || current?.status === "done"
    if (outcome.notify && people && sending) {
      try {
        await this.deliverRun(occurrence, task, people, outcome.notify, signal)
      } catch {
        // A Store error mid-send: the rows stay owed (a claim left open settles as unconfirmed).
      }
    }
    return "ran"
  }

  /** After a Store error past the record: back to the queue to resume, a bounded number of times. */
  private async putBack(occurrence: Occurrence, record: RunRecord, err: unknown): Promise<Verdict> {
    const { store, clock } = this.d
    const message = err instanceof Error ? err.message : String(err)
    const resumes = record.resumes + 1
    // Each write is compare-and-set on `running` and may itself fail: a run this cannot move is
    // left `running`, and a later tick's sweep puts it back (`STALE_RUN_MS`).
    try {
      await this.event(occurrence, "error", message)
      if (resumes > MAX_RESUMES) {
        // The type did not fail, so neither does the run: it ends with the error on record.
        await store.updateOccurrenceIf(occurrence.id, "running", {
          status: "done",
          finishedAt: clock.now().toISOString(),
          error: `could not finish after ${MAX_RESUMES} tries: ${message}`,
        })
        return "failed"
      }
      await store.updateOccurrenceIf(occurrence.id, "running", {
        status: "queued",
        startedAt: null,
        record: { ...record, resumes },
      })
    } catch {
      // Left running for the sweep.
    }
    return "held"
  }

  /** Whether a run of `taskId` other than `except` has fired and is still finishing. */
  private async finishing(taskId: string, except: string): Promise<boolean> {
    for (const status of ["queued", "running"] as const) {
      const runs = await this.d.store.listOccurrences({ taskId, status })
      if (runs.some((o) => o.id !== except && isFinishing(o))) return true
    }
    return false
  }

  /** Sends what a run owes now, to the owner and whoever still receives the task. */
  private async deliverRun(
    occurrence: Occurrence,
    task: Task,
    people: { owner: User; recipients: User[] },
    message: NonNullable<Outcome["notify"]>,
    signal?: AbortSignal,
  ): Promise<void> {
    const targets = new Map<string, User>()
    for (const u of [people.owner, ...people.recipients]) targets.set(u.id, u)
    await deliver(this.d.store, this.d.notifier, occurrence, task.ownerId, targets, message, {
      now: () => this.d.clock.now(),
      policy: this.d.delivery ?? DEFAULT_DELIVERY_POLICY,
      ...(signal ? { signal } : {}),
    })
  }

  /**
   * The sends still owed and due (retries, deferrals, rows a crash or an abort left), grouped by
   * run, from each run's recorded message. A paused task's rows wait (a pause buys them a fresh
   * round); rows whose run, record or task is gone, or whose task was archived, end unsent. A
   * claim left open past `STALE_CLAIM_MS` settles as unconfirmed. Writes no event.
   */
  private async deliverOwed(signal?: AbortSignal): Promise<void> {
    const { store, clock } = this.d
    await settleStaleClaims(store, clock.now())
    const byRun = new Map<string, Delivery[]>()
    for (const row of await store.listDeliveries({ dueBefore: clock.now().toISOString() })) {
      byRun.set(row.occurrenceId, [...(byRun.get(row.occurrenceId) ?? []), row])
    }
    for (const [occurrenceId, rows] of byRun) {
      if (signal?.aborted) return
      try {
        const occurrence = await store.getOccurrence(occurrenceId)
        const record = occurrence ? parseRunRecord(occurrence.record) : null
        const task = occurrence ? await store.getTask(occurrence.taskId) : null
        const message = record?.outcome.notify
        const people = task ? await this.audience(task) : null
        if (!occurrence || !message || !task || !people || task.status === "archived") {
          await dropOwed(store, rows, "the run or its task is gone", clock.now())
          continue
        }
        if (task.status === "paused") {
          await freshRoundForPause(store, rows)
          continue
        }
        await this.deliverRun(occurrence, task, people, message, signal)
      } catch {
        // A Store error: the rows stay owed and are tried again on a later tick.
      }
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
    const key = `usage-limit:${err.window}`
    await noticeOnce(
      store,
      notifier,
      key,
      clock.now(),
      usageLimitAdminMessage(err.parsed ? new Date(err.window) : err.until, err.parsed, err.until),
    )
  }

  /**
   * The run's charge to its owner: one call and its estimate. A usage limit charges nobody and
   * stops the lane; an auth failure reached no model and charges nobody, and still goes to the
   * type's `finish` (the runner's auth probe is what catches a dead token, plan 5.12). When the
   * runner's fetch Jobs arrive (E9) they make no model call and must not be charged here.
   */
  private async chargeRun(occurrence: Occurrence, task: Task, result: JobResult) {
    if (result.kind === "usage_limit") {
      const now = this.d.clock.now()
      const reset = result.resetsAt ? new Date(result.resetsAt) : null
      if (reset && !Number.isNaN(reset.getTime()) && reset > now) {
        // A misread reset a year out must not park the lane until a restart: wait at most a
        // day, then try once more. The notice stays keyed on the named reset, so it goes once.
        const until = new Date(Math.min(reset.getTime(), now.getTime() + MAX_USAGE_LIMIT_WAIT_MS))
        throw new UsageLimitReached(until, true, reset.toISOString())
      }
      // No usable reset: back off an hour, and tell the admins once per five-hour window.
      const window = Math.floor(now.getTime() / USAGE_WINDOW_MS)
      throw new UsageLimitReached(
        new Date(now.getTime() + USAGE_LIMIT_BACKOFF_MS),
        false,
        `unknown:${window}`,
      )
    }
    if (result.kind === "auth_failed") return
    await charge(this.d.store, {
      userId: task.ownerId,
      taskId: task.id,
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
    await this.chargeRun(occurrence, ctx.task, result)
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
    // Compare-and-set on the status the run has now, so a snooze never overwrites a change made
    // since. Only a finished run is snoozed: one still finishing, or not yet fired, is `queued`
    // or `running` (a text reply's answer can reach here for one; `runRefusal` stops the rest).
    const current = await store.getOccurrence(occurrence.id)
    if (!current || (current.status !== "done" && current.status !== "failed")) return
    if (!(await store.updateOccurrenceIf(current.id, current.status, { status: "snoozed" }))) return
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
    await this.d.store.updateOccurrence(occurrence.id, {
      status: "failed",
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
