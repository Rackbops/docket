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

/** Sends `message` to every target not yet delivered to, recording each send as it happens. */
export async function deliver(
  store: Store,
  notifier: Notifier,
  occurrence: Occurrence,
  targets: readonly User[],
  message: OutgoingMessage,
  now: () => Date,
): Promise<DeliveryReport> {
  const done = await deliveredTo(store, occurrence.id)
  const report: DeliveryReport = { sent: [], skipped: [] }
  for (const target of targets) {
    if (done.has(target.id)) {
      report.skipped.push(target.id)
      continue
    }
    const { messageId } = await notifier.sendDm(target.id, message)
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
