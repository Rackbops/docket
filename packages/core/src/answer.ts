import type { ReplyKind, Task } from "./model.js"
import type { Store } from "./ports.js"
import { hasFired, isFinishing } from "./record.js"

/**
 * Who may answer a run, and when (plan 1.1: recipients "receive only; they do not act on the
 * task"). `Lanes.reply` enforces it on every path -- a button, a slash command, a typed reply --
 * and `replyForRef` asks the same question first so a press gets the reason, not a throw.
 */

/** The kinds that answer a run: the owner's alone. `text` is a reply, not an answer. */
export const RUN_KINDS: ReadonlySet<ReplyKind> = new Set(["done", "snooze", "decision"])

export const NOT_YOURS = "That is not yours to answer."
export const OVER = "That run is over; answer the latest message instead."
export const STILL_FINISHING = "That run is still finishing; try again in a minute."

/** A run reply `Lanes.reply` would not act on; its message is the reason to show. */
export class ReplyRefusedError extends Error {
  override name = "ReplyRefusedError"
}

/**
 * Why `userId` may not answer `occurrenceId` of `task` with a run kind, or null when they may:
 * the owner, on a run of an active task that has fired (running, done or failed), is not
 * snoozed and is not yet answered. A failed or running run still counts: the owner's copy goes
 * out first, so a press can land while the rest are still sending or after another recipient's
 * send failed. A run counts as fired once its outcome is recorded, whatever it still owes anyone.
 * A fired run still finishing (`isFinishing`: its outcome not yet applied and the run not yet
 * marked done, for instance put back after a Store error) cannot be answered either, so a snooze
 * or done never races the steps that finish it.
 * A queued or running run that has not fired cannot be answered: a snoozed row
 * keeps the run's scheduled key, so a snooze that fired before the run's own due time would leave
 * the task nothing to materialize, and a recurring task would stall.
 */
export async function runRefusal(
  store: Store,
  task: Task,
  occurrenceId: string | null,
  userId: string,
): Promise<string | null> {
  if (task.ownerId !== userId) return NOT_YOURS
  if (occurrenceId === null) return "Answer the message for the run you mean."
  const occurrence = await store.getOccurrence(occurrenceId)
  if (!occurrence || occurrence.taskId !== task.id) return "That run no longer exists."
  if (task.status !== "active") return `That task is ${task.status}.`
  if (
    (occurrence.status === "queued" || occurrence.status === "running") &&
    !hasFired(occurrence)
  ) {
    return "That run has not fired yet."
  }
  if (isFinishing(occurrence)) return STILL_FINISHING
  if (occurrence.status === "snoozed" || occurrence.status === "skipped") return OVER
  const answered = (await store.listReplies(task.id)).some(
    (r) => r.occurrenceId === occurrence.id && RUN_KINDS.has(r.kind),
  )
  return answered ? "That run has already been answered." : null
}
