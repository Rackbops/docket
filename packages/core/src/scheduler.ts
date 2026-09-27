import { scheduledKey } from "./dedupe.js"
import type { Occurrence, Task, User } from "./model.js"
import type { Store } from "./ports.js"
import { nextDue, type Schedule, scheduleProblems } from "./schedule.js"

/**
 * Materialization (plan section 5.3): a task keeps exactly one upcoming occurrence, created
 * through its dedupe key so a repeated call is a no-op. A schedule edit cancels the queued
 * occurrence and replaces it. Catch-up is per kind: a missed `once` fires late and is marked late;
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
 * not active, has no schedule, already has a pending occurrence, or is never due again.
 */
export async function materialize(
  store: Store,
  task: Task,
  owner: User,
  now: Date,
): Promise<Occurrence | null> {
  if (task.status !== "active" || !task.schedule) return null
  const pending = await store.listOccurrences({ taskId: task.id })
  if (pending.some((o) => o.status === "queued" || o.status === "running")) return null
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
}

/** Replaces the schedule: cancels queued occurrences, records the edit, materializes the next. */
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
  const at = now.toISOString()
  const removed = await store.deleteQueuedOccurrences(task.id)
  const updated = await store.updateTask(task.id, { schedule, at })
  await store.addTaskEvent({
    taskId: task.id,
    actorId,
    kind: "schedule_changed",
    detail: JSON.stringify(schedule),
    at,
  })
  return { task: updated, removed, next: await materialize(store, updated, owner, now) }
}
