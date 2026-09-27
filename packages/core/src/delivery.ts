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

export interface DeliverOptions {
  /**
   * The task's owner. Every other target is a recipient, and a recipient's copy carries the
   * opt-out the consent rule promises on every message (plan 5.5).
   */
  ownerId?: string
}

/** The copy one target receives: the reply reference, and the opt-out for a recipient. */
export function messageFor(
  message: OutgoingMessage,
  occurrence: Occurrence,
  target: User,
  options: DeliverOptions = {},
): OutgoingMessage {
  const ref = { taskId: occurrence.taskId, occurrenceId: occurrence.id }
  const recipient = options.ownerId !== undefined && target.id !== options.ownerId
  const actions = message.actions ?? []
  if (!recipient || actions.includes("opt_out")) return { ...message, ref }
  return { ...message, actions: [...actions, "opt_out"], ref }
}

/**
 * Sends `message` to every target not yet delivered to, recording each send as it happens.
 * Each copy carries the occurrence as its reply reference; with `ownerId`, recipients' copies
 * also carry the opt-out.
 */
export async function deliver(
  store: Store,
  notifier: Notifier,
  occurrence: Occurrence,
  targets: readonly User[],
  message: OutgoingMessage,
  now: () => Date,
  options: DeliverOptions = {},
): Promise<DeliveryReport> {
  const done = await deliveredTo(store, occurrence.id)
  const report: DeliveryReport = { sent: [], skipped: [] }
  for (const target of targets) {
    if (done.has(target.id)) {
      report.skipped.push(target.id)
      continue
    }
    const { messageId } = await notifier.sendDm(
      target.id,
      messageFor(message, occurrence, target, options),
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
