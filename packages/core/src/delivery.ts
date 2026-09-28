import { RUN_KINDS } from "./answer.js"
import type { Occurrence, User } from "./model.js"
import type { Notifier, OutgoingMessage, Store } from "./ports.js"

/**
 * Delivery idempotency (plan section 5.5). Crash recovery requeues anything left running, so a DM
 * sent just before a crash would be sent again. The `delivered` event, carrying the recipient
 * and the provider's message id, is written right after each send and before the status flip; a
 * requeued occurrence with one is not resent to that person.
 */

export const NOTIFIER = "notifier"

export interface DeliveryReport {
  sent: string[]
  skipped: string[]
}

/** Who an occurrence has already been delivered to, from its events. */
export async function deliveredTo(store: Store, occurrenceId: string): Promise<Set<string>> {
  const events = await store.listEvents(occurrenceId)
  return new Set(
    events.filter((e) => e.type === "delivered").map((e) => e.text.split(" ")[0] ?? ""),
  )
}

/**
 * The copy one target receives, with the reply reference. The owner's carries the run's actions
 * and never an opt-out; a recipient's (anyone but `ownerId`) drops what only the owner answers
 * (`RUN_KINDS`; recipients receive only, plan 1.1)
 * and carries the opt-out the consent rule promises on every message (plan 5.5).
 */
export function messageFor(
  message: OutgoingMessage,
  occurrence: Occurrence,
  target: User,
  ownerId: string,
): OutgoingMessage {
  const ref = { taskId: occurrence.taskId, occurrenceId: occurrence.id }
  const actions = message.actions ?? []
  if (target.id === ownerId) {
    return { ...message, actions: actions.filter((a) => a !== "opt_out"), ref }
  }
  const { decisions: _owners, ...rest } = message
  const kept = actions.filter((a) => !RUN_KINDS.has(a) && a !== "opt_out")
  return { ...rest, actions: [...kept, "opt_out"], ref }
}

/**
 * Sends `message` to every target not yet delivered to, recording each send as it happens.
 * Each copy carries the occurrence as its reply reference; the task's owner, read from the
 * store, decides which copy is the owner's (`messageFor`), so no caller can leave the opt-out off.
 */
export async function deliver(
  store: Store,
  notifier: Notifier,
  occurrence: Occurrence,
  targets: readonly User[],
  message: OutgoingMessage,
  now: () => Date,
): Promise<DeliveryReport> {
  const task = await store.getTask(occurrence.taskId)
  if (!task) throw new Error(`no task ${occurrence.taskId}`)
  const done = await deliveredTo(store, occurrence.id)
  const report: DeliveryReport = { sent: [], skipped: [] }
  for (const target of targets) {
    if (done.has(target.id)) {
      report.skipped.push(target.id)
      continue
    }
    const { messageId } = await notifier.sendDm(
      target.id,
      messageFor(message, occurrence, target, task.ownerId),
    )
    await store.addEvent({
      occurrenceId: occurrence.id,
      agent: NOTIFIER,
      type: "delivered",
      text: `${target.id} ${messageId}`,
      at: now().toISOString(),
    })
    done.add(target.id)
    report.sent.push(target.id)
  }
  return report
}
