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
  return `snooze:${occurrenceId}`
}

/** city-hall's issue-label claim, `(repo, issue, workflow)`, re-homed (plan 5.11). */
export function issueKey(repo: string, issue: number, workflow: string): string {
  return `issue:${repo}:${issue}:${workflow}`
}
