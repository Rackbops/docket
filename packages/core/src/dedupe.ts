/**
 * Occurrence identity per source (plan section 5.2). One `occurrences` table serves every
 * source because each computes its own key, and the Store keeps the column unique: creating an
 * occurrence whose key exists is a no-op, which is what makes materialization idempotent.
 */

/** A scheduled occurrence: the task and the instant it is due. */
export function scheduledKey(taskId: string, dueAt: Date | string): string {
  const iso = typeof dueAt === "string" ? new Date(dueAt).toISOString() : dueAt.toISOString()
  return `sched:${taskId}:${iso}`
}

/** An on-demand run, or anything else a person asked for outside the schedule. */
export function manualKey(taskId: string, seq: number): string {
  return `manual:${taskId}:${seq}`
}

/**
 * The run a snooze of `occurrenceId` queues: one per snoozed run, so a double-tapped Snooze that
 * gets past every other check still queues one reminder.
 */
export function snoozeKey(occurrenceId: string): string {
  return `${SNOOZE_PREFIX}${occurrenceId}`
}

export const SNOOZE_PREFIX = "snooze:"

/**
 * The run a finished run asked for (`Outcome.followUp`): one per asking run, so an outcome
 * applied twice after a crash still queues one. Like a snooze's run it is off the schedule: the
 * schedule never stands it in for its next run, and an edit never cancels it.
 */
export function followUpKey(occurrenceId: string): string {
  return `${FOLLOW_UP_PREFIX}${occurrenceId}`
}

export const FOLLOW_UP_PREFIX = "followup:"

/** True for a run a person or a type asked for (a snooze's, a follow-up), not a scheduled one. */
export function isOffSchedule(dedupeKey: string): boolean {
  return dedupeKey.startsWith(SNOOZE_PREFIX) || dedupeKey.startsWith(FOLLOW_UP_PREFIX)
}
