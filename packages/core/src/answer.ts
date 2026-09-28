import type { ReplyKind, Task } from "./model.js"
import type { Store } from "./ports.js"

/**
 * Who may answer a run, and when (plan 1.1: recipients "receive only; they do not act on the
 * task"). `Lanes.reply` enforces it on every path -- a button, a slash command, a typed reply --
 * and `replyForRef` asks the same question first so a press gets the reason, not a throw.
 */

/** The kinds that answer a run: the owner's alone. `text` is a reply, not an answer. */
export const RUN_KINDS: ReadonlySet<ReplyKind> = new Set(["done", "snooze", "decision"])

export const NOT_YOURS = "That button is not yours to press any more."
export const OVER = "That run is over; answer the latest message instead."

/** A run reply `Lanes.reply` would not act on; its message is the reason to show. */
export class ReplyRefusedError extends Error {
  override name = "ReplyRefusedError"
}

/**
 * Why `userId` may not answer `occurrenceId` of `task` with a run kind, or null when they may:
 * the owner, on a run of an active task that is not snoozed and not yet answered. The run's own
 * status is otherwise no bar: the owner's copy goes out first, so a press can land while the
 * rest are still sending or after another recipient's send failed the run, and `/task snooze`
 * may name a run that has not fired yet.
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
  if (occurrence.status === "snoozed") return OVER
  const answered = (await store.listReplies(task.id)).some(
    (r) => r.occurrenceId === occurrence.id && RUN_KINDS.has(r.kind),
  )
  return answered ? "That run has already been answered." : null
}
