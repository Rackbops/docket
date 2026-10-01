import { isOffSchedule, scheduledKey } from "./dedupe.js"
import { hasJobOut } from "./job-state.js"
import type { Occurrence, Task, User } from "./model.js"
import type { Store } from "./ports.js"
import { hasFired } from "./record.js"
import { nextDue, type Schedule, scheduleProblems } from "./schedule.js"

/**
 * Materialization (plan section 5.3): a task keeps exactly one upcoming occurrence, created
 * through its dedupe key so a repeated call is a no-op. A schedule edit cancels the queued
 * occurrence and replaces it, keeping a snooze's run, a follow-up and any run that has fired.
 * Catch-up is per kind: a missed `once` fires late and is marked late;
 * a missed calendar or period occurrence fires once late, then the next is computed from now; a
 * poll's first occurrence is its `start` (so a tracker observes at once), every later one the
 * next grid instant after now.
 */

/** A run starting this long after its due instant is marked late. */
export const LATE_AFTER_MS = 5 * 60_000

export class ScheduleError extends Error {
  override name = "ScheduleError"
}

export function isLate(occurrence: Occurrence, now: Date): boolean {
  return now.getTime() - Date.parse(occurrence.dueAt) > LATE_AFTER_MS
}

/**
 * Creates the task's next occurrence if it has none pending. Returns it, or null when the task is
 * not active, has no schedule, already has a pending scheduled occurrence (a snooze's run does
 * not count), or is never due again.
 */
export async function materialize(
  store: Store,
  task: Task,
  owner: User,
  now: Date,
): Promise<Occurrence | null> {
  if (task.status !== "active" || !task.schedule) return null
  const pending = await store.listOccurrences({ taskId: task.id })
  // A snooze's run re-asks an earlier one, and a follow-up continues one; neither stands in for
  // the next scheduled run, so a snooze longer than the period drops none of them. Nor does a run
  // that has fired: whatever it still has to finish or send, the schedule moves on the moment its
  // outcome is recorded.
  const scheduled = pending.filter((o) => !isOffSchedule(o.dedupeKey) && !hasFired(o))
  if (scheduled.some((o) => o.status === "queued" || o.status === "running")) return null
  const after = firstDueAfter(task.schedule, pending.length === 0, now)
  const due = nextDue(task.schedule, after, {
    zone: owner.timeZone,
    preferredHour: owner.preferredHour,
  })
  if (!due) return null
  return store.createOccurrence({
    taskId: task.id,
    lane: task.lane,
    dueAt: due.toISOString(),
    dedupeKey: scheduledKey(task.id, due),
    at: now.toISOString(),
  })
}

/** The instant `nextDue` searches from: the epoch for `once`, the start for a fresh poll. */
function firstDueAfter(schedule: Schedule, fresh: boolean, now: Date): Date {
  if (schedule.kind === "once") return new Date(0)
  if (schedule.kind === "poll" && fresh) return new Date(Date.parse(schedule.start) - 1)
  return now
}

export interface RescheduleResult {
  task: Task
  /** Queued occurrences cancelled by the edit. */
  removed: number
  next: Occurrence | null
  /**
   * A run of the task has a Job out at the runner: it was kept, will be collected, and the new
   * schedule's next run follows it. A host tells the owner so.
   */
  jobOut: boolean
}

/**
 * Cancels the task's queued scheduled runs that have not fired: what a schedule computed, at a
 * time the edit makes stale (plan 5.3). A snooze's run stays -- it is an instant the owner asked
 * for, not one the schedule computed -- as does a follow-up a run asked for (a research request's
 * reviewer run), a run that fired and was put back to finish (`dispatch.ts`), and a run whose
 * Job is out at the runner (`job-state.ts`): cancelling it would submit the call again under a
 * new key, uncharged. Returns how many were cancelled.
 */
export async function cancelScheduledRuns(store: Store, taskId: string): Promise<number> {
  let removed = 0
  for (const o of await store.listOccurrences({ taskId, status: "queued" })) {
    if (isOffSchedule(o.dedupeKey) || hasFired(o) || (await hasJobOut(store, o))) continue
    if (await store.deleteOccurrence(o.id)) removed += 1
  }
  return removed
}

async function anyJobOut(store: Store, taskId: string): Promise<boolean> {
  for (const o of await store.listOccurrences({ taskId, status: "queued" })) {
    if (!hasFired(o) && (await hasJobOut(store, o))) return true
  }
  return false
}

/**
 * Replaces the schedule: cancels the queued scheduled runs (`cancelScheduledRuns`, snoozes kept),
 * records the edit, materializes the next. Refused (`ScheduleError`) for a `once` schedule, old or
 * new, while the task's run has a Job out: that run is the task, and the edit would run it twice.
 *
 * The host serializes this with the lanes per task: a run firing between the cancel and the
 * schedule write materializes its next run from the old schedule, and that run survives beside
 * the new one. Run a task's edits and its ticks one at a time (the tracker plugin's per-task
 * queue), as for replies (`Lanes.reply`).
 */
export async function reschedule(
  store: Store,
  task: Task,
  owner: User,
  schedule: Schedule | null,
  actorId: string | null,
  now: Date,
): Promise<RescheduleResult> {
  if (schedule) {
    const problems = scheduleProblems(schedule)
    if (problems.length > 0) throw new ScheduleError(problems.join("; "))
  }
  const jobOut = await anyJobOut(store, task.id)
  // A `once` task's run is the task: with its Job out, a new instant would run it twice.
  if (jobOut && (schedule?.kind === "once" || task.schedule?.kind === "once")) {
    throw new ScheduleError(
      "its run is with the runner now; change when it runs once that run is back",
    )
  }
  const at = now.toISOString()
  const removed = await cancelScheduledRuns(store, task.id)
  const updated = await store.updateTask(task.id, { schedule, at })
  await store.addTaskEvent({
    taskId: task.id,
    actorId,
    kind: "schedule_changed",
    detail: JSON.stringify(schedule),
    at,
  })
  return { task: updated, removed, next: await materialize(store, updated, owner, now), jobOut }
}
