import { RUN_KINDS } from "./answer.js"
import type { Delivery, Occurrence, User } from "./model.js"
import {
  DeliveryFailedError,
  ExecutorUnavailableError,
  type Notifier,
  type OutgoingMessage,
  type Store,
} from "./ports.js"

/**
 * Delivery idempotency (plan section 5.5). Crash recovery requeues anything left running, and the
 * bot host abandons a slow tick without stopping it, so a send could go out twice. `deliver`
 * therefore **claims each recipient's copy in the Store before it sends** (`claimDelivery`),
 * settles the claim after, and never sends on a claim it did not just take:
 *
 * - a `sent` claim is skipped: that person has it;
 * - a claim found still `claimed` never reported back and may have gone out, so it is settled
 *   `unconfirmed` and never resent; so is a send that failed in a way that does not say whether
 *   it went out. A host shows these to an admin rather than guess (`listDeliveries`);
 * - a send that failed with nothing sent (`DeliveryFailedError`) is `failed`, and a later
 *   delivery of the same run claims it again, up to `attempts` sends in all;
 * - a send the Notifier deferred (`ExecutorUnavailableError`), or one not reached because the
 *   signal aborted, went nowhere and counts no attempt.
 *
 * One recipient's failure never stops the others: each gets their own outcome in the report and
 * on the claim, and a `delivered` or `undelivered` event on the run for its history. The host
 * needs no claim table of its own.
 */

export const NOTIFIER = "notifier"

/** Sends of one run's message to one person before the run gives up on them. */
export const DEFAULT_DELIVERY_ATTEMPTS = 3

export interface DeliveryFailure {
  userId: string
  error: string
  /** The Notifier said this person cannot be messaged at all. */
  unreachable: boolean
  /** Failed sends so far, this one included. */
  attempts: number
  /** At the attempt limit: this run sends to them no more. */
  gaveUp: boolean
}

export interface DeliveryReport {
  /** Sent by this call. */
  sent: string[]
  /** Delivered before, or claimed by another sender just now: not sent again. */
  skipped: string[]
  /** Nothing went out; retried by a later delivery of the run unless `gaveUp`. */
  failed: DeliveryFailure[]
  /** Deferred by the Notifier or the signal: nothing went out, no attempt counted. */
  deferred: string[]
  /** May have gone out and was never confirmed: never resent. */
  unconfirmed: string[]
}

export interface DeliverOptions {
  now: () => Date
  /** Sends per person before giving up; `DEFAULT_DELIVERY_ATTEMPTS` when absent. */
  attempts?: number
  /** Once aborted, no further send starts; the rest are `deferred`. */
  signal?: AbortSignal
}

/** Who an occurrence has been delivered to, from its claims. */
export async function deliveredTo(store: Store, occurrenceId: string): Promise<Set<string>> {
  const sent = await store.listDeliveries({ occurrenceId, status: "sent" })
  return new Set(sent.map((d) => d.userId))
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

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Sends `message` to every target not yet delivered to, claiming each send first. Each copy
 * carries the occurrence as its reply reference; the task's owner, read from the store, decides
 * which copy is the owner's (`messageFor`), so no caller can leave the opt-out off. Throws only
 * when the Store does; every Notifier failure lands in the report.
 */
export async function deliver(
  store: Store,
  notifier: Notifier,
  occurrence: Occurrence,
  targets: readonly User[],
  message: OutgoingMessage,
  options: DeliverOptions,
): Promise<DeliveryReport> {
  const task = await store.getTask(occurrence.taskId)
  if (!task) throw new Error(`no task ${occurrence.taskId}`)
  const limit = options.attempts ?? DEFAULT_DELIVERY_ATTEMPTS
  const at = () => options.now().toISOString()
  const prior = new Map<string, Delivery>()
  for (const d of await store.listDeliveries({ occurrenceId: occurrence.id })) {
    prior.set(d.userId, d)
  }
  const report: DeliveryReport = {
    sent: [],
    skipped: [],
    failed: [],
    deferred: [],
    unconfirmed: [],
  }
  const note = (type: "delivered" | "undelivered", text: string) =>
    store.addEvent({ occurrenceId: occurrence.id, agent: NOTIFIER, type, text, at: at() })

  for (const target of targets) {
    const before = prior.get(target.id)
    if (before?.status === "sent") {
      report.skipped.push(target.id)
      continue
    }
    if (before?.status === "unconfirmed") {
      report.unconfirmed.push(target.id)
      continue
    }
    if (before?.status === "claimed") {
      // A claim no send ever settled: it may have gone out. Never guessed at, never resent.
      const error = "claimed, never settled"
      await store.settleDelivery(occurrence.id, target.id, {
        status: "unconfirmed",
        error,
        attempts: before.attempts,
        at: at(),
      })
      await note("undelivered", `${target.id} ${error}`)
      report.unconfirmed.push(target.id)
      continue
    }
    if (before?.status === "failed" && before.attempts >= limit) {
      const error = before.error ?? "failed"
      report.failed.push({
        userId: target.id,
        error,
        unreachable: false,
        attempts: before.attempts,
        gaveUp: true,
      })
      continue
    }
    if (options.signal?.aborted) {
      report.deferred.push(target.id)
      continue
    }
    const claim = await store.claimDelivery(occurrence.id, target.id, at())
    if (!claim) {
      // Another sender took it between the read above and here: never send on their claim.
      report.skipped.push(target.id)
      continue
    }
    let messageId: string
    try {
      ;({ messageId } = await notifier.sendDm(
        target.id,
        messageFor(message, occurrence, target, task.ownerId),
      ))
    } catch (err) {
      const error = reason(err)
      if (err instanceof ExecutorUnavailableError) {
        await store.settleDelivery(occurrence.id, target.id, {
          status: "failed",
          error: `deferred: ${error}`,
          attempts: claim.attempts,
          at: at(),
        })
        report.deferred.push(target.id)
      } else if (err instanceof DeliveryFailedError) {
        const attempts = claim.attempts + 1
        await store.settleDelivery(occurrence.id, target.id, {
          status: "failed",
          error,
          attempts,
          at: at(),
        })
        await note("undelivered", `${target.id} ${error}`)
        report.failed.push({
          userId: target.id,
          error,
          unreachable: err.unreachable,
          attempts,
          gaveUp: attempts >= limit,
        })
      } else {
        await store.settleDelivery(occurrence.id, target.id, {
          status: "unconfirmed",
          error,
          attempts: claim.attempts,
          at: at(),
        })
        await note("undelivered", `${target.id} ${error}`)
        report.unconfirmed.push(target.id)
      }
      continue
    }
    await store.settleDelivery(occurrence.id, target.id, {
      status: "sent",
      messageId,
      attempts: claim.attempts,
      at: at(),
    })
    await note("delivered", `${target.id} ${messageId}`)
    report.sent.push(target.id)
  }
  return report
}
