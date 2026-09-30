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
 * Delivery (plan section 5.5, "Delivery idempotency"). When a run fires, one row per person it
 * goes to is planned in the Store (`planDelivery`); each send is **claimed before it is made**
 * (`claimDelivery`) and settled after, and a send is only ever made on a claim just taken. So a
 * host keeps no claim table, and nobody gets a run's message twice:
 *
 * - `sent`: done. A claim found still `claimed` after a crash (`recover`) or long after
 *   (`STALE_CLAIM_MS`) may have gone out: settled `unconfirmed`, never resent. So is a send that
 *   failed in a way that does not say whether it went out (any error but the two below).
 * - `DeliveryFailedError` (nothing went out): with `unreachable` -- the person cannot be messaged
 *   at all -- the row fails for good at once, so a host's pause-after-three counts runs, not
 *   ticks; otherwise it is retried with a backoff, `policy.attempts` sends in all.
 * - `ExecutorUnavailableError` (not now, nothing went out): `deferred`, retried with a backoff,
 *   `policy.deferrals` times in all, then failed for good. No attempt is counted.
 * - Once the signal aborts, no further send starts; the rest stay owed, untouched.
 *
 * One person's failure never holds up anyone else's copy. Per-person outcomes live in the
 * deliveries alone, never in the run's shared event log, so a recipient reading a run's history
 * learns nothing about who else receives it (plan 5.10).
 */

export interface DeliveryPolicy {
  /** Sends that fail with nothing sent before a row fails for good. */
  attempts: number
  /** Deferrals before a row fails for good. */
  deferrals: number
  /** The first retry's wait; each later one doubles, up to `maxBackoffMs`. */
  backoffMs: number
  maxBackoffMs: number
}

export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  attempts: 3,
  deferrals: 8,
  backoffMs: 60_000,
  maxBackoffMs: 3_600_000,
}

/** A claim still unsettled this long after it was taken is treated as unconfirmed. */
export const STALE_CLAIM_MS = 10 * 60_000

/** The wait before the `n`th retry (n from 1): the backoff, doubling, capped. */
export function backoff(policy: DeliveryPolicy, n: number): number {
  return Math.min(policy.backoffMs * 2 ** Math.max(0, n - 1), policy.maxBackoffMs)
}

export interface DeliveryReport {
  /** Sent by this call. */
  sent: string[]
  /** Nothing went out; owed again later (a failure with tries left, or a deferral). */
  retrying: string[]
  /** Failed for good by this call. */
  failed: string[]
  /** May have gone out and was never confirmed: never resent. */
  unconfirmed: string[]
  /** Owed, and not tried by this call: the signal aborted, or another sender holds the claim. */
  untried: string[]
}

export interface DeliverOptions {
  now: () => Date
  policy?: DeliveryPolicy
  /** Once aborted, no further send starts. */
  signal?: AbortSignal
}

/** Who an occurrence has been delivered to. */
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

function emptyReport(): DeliveryReport {
  return { sent: [], retrying: [], failed: [], unconfirmed: [], untried: [] }
}

/**
 * Sends `message` on each owed row of `occurrence` that is due now, claiming each first. `targets`
 * are the people it may still go to, by id: a row for anyone else (they opted out, were removed)
 * fails for good unsent. `ownerId` decides which copy is the owner's (`messageFor`), so no caller
 * can leave the opt-out off. Throws only when the Store does; every Notifier failure is settled.
 */
export async function deliver(
  store: Store,
  notifier: Notifier,
  occurrence: Occurrence,
  ownerId: string,
  targets: ReadonlyMap<string, User>,
  message: OutgoingMessage,
  options: DeliverOptions,
): Promise<DeliveryReport> {
  const policy = options.policy ?? DEFAULT_DELIVERY_POLICY
  const now = () => options.now()
  const report = emptyReport()
  const owed = await store.listDeliveries({
    occurrenceId: occurrence.id,
    dueBefore: now().toISOString(),
  })
  for (const row of owed) {
    if (options.signal?.aborted) {
      report.untried.push(row.userId)
      continue
    }
    const target = targets.get(row.userId)
    if (!target) {
      await finalFail(store, row, "no longer a recipient", now())
      report.failed.push(row.userId)
      continue
    }
    const claim = await store.claimDelivery(occurrence.id, row.userId, now().toISOString())
    if (!claim) {
      // Another sender took it between the read above and here: never send on their claim.
      report.untried.push(row.userId)
      continue
    }
    await sendOne(store, notifier, occurrence, claim, target, ownerId, message, policy, now, report)
  }
  return report
}

async function sendOne(
  store: Store,
  notifier: Notifier,
  occurrence: Occurrence,
  claim: Delivery,
  target: User,
  ownerId: string,
  message: OutgoingMessage,
  policy: DeliveryPolicy,
  now: () => Date,
  report: DeliveryReport,
): Promise<void> {
  const settle = (s: Parameters<Store["settleDelivery"]>[2]) =>
    store.settleDelivery(occurrence.id, claim.userId, s)
  const counts = { attempts: claim.attempts, deferrals: claim.deferrals }
  let messageId: string
  try {
    ;({ messageId } = await notifier.sendDm(
      target.id,
      messageFor(message, occurrence, target, ownerId),
    ))
  } catch (err) {
    const error = reason(err)
    const at = now()
    if (err instanceof ExecutorUnavailableError) {
      const deferrals = claim.deferrals + 1
      const last = deferrals >= policy.deferrals
      await settle({
        status: last ? "failed" : "deferred",
        error,
        ...counts,
        deferrals,
        retryAt: last ? null : new Date(at.getTime() + backoff(policy, deferrals)).toISOString(),
        at: at.toISOString(),
      })
      ;(last ? report.failed : report.retrying).push(claim.userId)
    } else if (err instanceof DeliveryFailedError) {
      const attempts = claim.attempts + 1
      const last = err.unreachable || attempts >= policy.attempts
      await settle({
        status: "failed",
        error,
        ...counts,
        attempts,
        retryAt: last ? null : new Date(at.getTime() + backoff(policy, attempts)).toISOString(),
        at: at.toISOString(),
      })
      ;(last ? report.failed : report.retrying).push(claim.userId)
    } else {
      await settle({ status: "unconfirmed", error, ...counts, retryAt: null, at: at.toISOString() })
      report.unconfirmed.push(claim.userId)
    }
    return
  }
  await settle({ status: "sent", messageId, ...counts, retryAt: null, at: now().toISOString() })
  report.sent.push(claim.userId)
}

async function finalFail(store: Store, row: Delivery, error: string, at: Date): Promise<void> {
  await store.settleDelivery(row.occurrenceId, row.userId, {
    status: "failed",
    error,
    attempts: row.attempts,
    deferrals: row.deferrals,
    retryAt: null,
    at: at.toISOString(),
  })
}

/** Ends every owed row of a run that can no longer be delivered (its task or run is gone). */
export async function dropOwed(
  store: Store,
  rows: readonly Delivery[],
  error: string,
  at: Date,
): Promise<void> {
  for (const row of rows) await finalFail(store, row, error, at)
}

/**
 * Claims that never settled: every one after a crash (`olderThan` omitted), or those taken more
 * than `STALE_CLAIM_MS` ago. Each is settled `unconfirmed` -- it may have gone out -- and never
 * resent. Returns how many.
 */
export async function settleStaleClaims(store: Store, now: Date, all = false): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString()
  let settled = 0
  for (const row of await store.listDeliveries({ status: "claimed" })) {
    if (!all && (row.claimedAt ?? "") > cutoff) continue
    await store.settleDelivery(row.occurrenceId, row.userId, {
      status: "unconfirmed",
      error: "claimed, never settled",
      attempts: row.attempts,
      deferrals: row.deferrals,
      retryAt: null,
      at: now.toISOString(),
    })
    settled += 1
  }
  return settled
}

/**
 * A pause buys a fresh round (plan 5.5): while the host holds a task paused, its owed rows wait,
 * and their attempts and deferrals are counted afresh, once, so the resume retries them in full.
 * Pause and resume therefore give `policy.attempts` more sends; that is intended. Writes nothing
 * for a row already at zero, so a paused task costs no writes tick after tick.
 */
export async function freshRoundForPause(store: Store, rows: readonly Delivery[]): Promise<void> {
  for (const row of rows) {
    if (row.attempts === 0 && row.deferrals === 0) continue
    await store.settleDelivery(row.occurrenceId, row.userId, {
      status: row.status === "claimed" ? "pending" : row.status,
      messageId: row.messageId,
      error: row.error,
      attempts: 0,
      deferrals: 0,
      retryAt: row.retryAt,
      at: row.settledAt ?? row.createdAt,
    })
  }
}
