import type { Capability } from "./capabilities.js"
import type { Outcome } from "./contract.js"
import type { Lane } from "./lanes.js"
import type { Schedule } from "./schedule.js"

/**
 * The tracker's records (plan section 5.2). Ids are opaque strings the Store assigns; instants
 * are ISO-8601 strings in UTC. A row's shape is what a host stores; the rules about it live in the
 * modules next to this one, never in a host.
 */

/** A person. A row can exist from a Discord id alone: an invited person who has not registered. */
export interface User {
  id: string
  /** The Discord user id, when known. */
  discordId: string | null
  displayName: string | null
  /** IANA zone; the host's default until the person sets one at registration (plan 5.8). */
  timeZone: string
  /** Local hour (0-23) at which digests and daily outputs reach this person. */
  preferredHour: number
  /**
   * The tracker's admin flag, kept in the tracker's own store: the one admin definition (plan
   * 5.8, 5.10). People are not usr accounts (plan item 40), so no usr role mirrors it.
   */
  admin: boolean
  createdAt: string
}

export type TaskStatus = "active" | "paused" | "done" | "archived"

export interface Task {
  id: string
  ownerId: string
  /** A task type id, e.g. `reminder`. */
  type: string
  title: string
  /** Type-specific configuration; the type's `intake` describes it. */
  config: unknown
  /**
   * Type state carried between runs: what a type's `Outcome.state` last returned, null until
   * then. Kenzen's current-row pattern: the current row lives here, the history in events,
   * replies and the series (plan 5.2, 5.4).
   */
  state: unknown
  schedule: Schedule | null
  lane: Lane
  /** Capabilities granted to this task, a subset of what its type declares. */
  capabilities: Capability[]
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export type OccurrenceStatus = "queued" | "running" | "done" | "failed" | "skipped" | "snoozed"

/**
 * One due instance of a task. It has **fired** once its outcome is recorded (`record` is set):
 * from then on the type never runs for it again, whatever its status, and what it owes anyone is
 * in its deliveries. A `queued` row with no record has not run.
 */
export interface Occurrence {
  id: string
  taskId: string
  lane: Lane
  dueAt: string
  startedAt: string | null
  finishedAt: string | null
  status: OccurrenceStatus
  /** Set when the run started well after `dueAt` (a missed occurrence fired late). */
  late: boolean
  /** Per-source identity: `sched:<task>:<due>`, `manual:<task>:<seq>`, `snooze:<occurrence>`. */
  dedupeKey: string
  summary: string | null
  costUsd: number | null
  error: string | null
  /** What the run produced, written by the dispatcher alone; null until the run fired. */
  record: RunRecord | null
  createdAt: string
}

/**
 * A run's outcome, stored on its occurrence before any of it is applied (`dispatch.ts`), so a run
 * that stopped after it (a crash, a Store error) resumes without running its type again. The
 * dispatcher is its only writer and validates it on every read (`parseRunRecord`). Readers other
 * than the owner and admins never see it (`visibleOccurrences`).
 */
export interface RunRecord {
  /** The type's outcome; never `snoozeUntil`, which only a reply produces. */
  outcome: Omit<Outcome, "snoozeUntil">
  costUsd: number | null
  firedAt: string
  /** When state and series were applied; null until then. */
  appliedAt: string | null
  /** Times the steps after the record were retried after an error. */
  resumes: number
}

/**
 * `delivered` is only on rows written before 0.4.0 (the user id, then the message id); who got a
 * run's message, and how each send went, is in its deliveries now, never in the shared event log.
 */
export type EventType = "status" | "text" | "tool" | "handoff" | "verdict" | "error" | "delivered"

/** One line of a run, or of the tracker talking about it. Append-only, keyed by occurrence. */
export interface OccurrenceEvent {
  id: string
  occurrenceId: string
  /** Who wrote it: an agent id, `docket`, or `notifier`. */
  agent: string
  type: EventType
  text: string
  at: string
}

export type TaskEventKind =
  | "created"
  | "edited"
  | "schedule_changed"
  | "recipient_invited"
  | "recipient_accepted"
  | "recipient_declined"
  | "recipient_opted_out"
  | "recipient_removed"
  | "granted"
  | "revoked"
  | "blocked"
  | "block_lifted"
  | "paused"
  | "resumed"
  | "completed"
  | "archived"

/** The history occurrence events miss: edits, recipients, grants, blocks, pauses (plan 5.2). */
export interface TaskEvent {
  id: string
  taskId: string
  /** The user who acted, or null for the tracker itself. */
  actorId: string | null
  kind: TaskEventKind
  detail: string
  at: string
}

export type ConsentState = "invited" | "accepted" | "declined" | "opted_out"

export interface TaskRecipient {
  taskId: string
  userId: string
  state: ConsentState
  at: string
}

/** The decline rule's record (plan 5.5): who may not invite whom, until when, and who lifted it. */
export interface InviteBlock {
  id: string
  ownerId: string
  recipientId: string
  /** Null means permanent until an admin lifts it. */
  expiresAt: string | null
  /** The decline reply that created it, when one did. */
  declineReplyId: string | null
  liftedBy: string | null
  liftedAt: string | null
  createdAt: string
}

export type ReplyKind = "accept" | "decline" | "opt_out" | "done" | "snooze" | "decision" | "text"

/** Anything a recipient sent back, routed to the task (plan 1.3, reply channel). */
export interface Reply {
  id: string
  /** The occurrence it answers, or null for a task-level reply such as accepting an invitation. */
  occurrenceId: string | null
  taskId: string
  userId: string
  kind: ReplyKind
  payload: unknown
  at: string
}

/**
 * One observation in a task's series (plan 5.2, E6): a price seen, an amount paid. The series
 * lives in the tracker's own store, never in recall; a type appends through `Outcome.series`.
 */
export interface SeriesPoint {
  id: string
  taskId: string
  /**
   * Identity for a point a run appends (`<occurrence>:<index>`): adding a point whose key is
   * stored is a no-op, so an outcome applied twice after a crash appends nothing twice. Null for a
   * point a host adds by hand.
   */
  key: string | null
  at: string
  value: number
  /** A currency code or other unit, when the value has one. */
  unit: string | null
  /** Why it was recorded: `observed`, `kept`, `renewed`, ... */
  note: string | null
}

/**
 * Where a charge came from: a run on the runner. The only source since plan item 37: the tracker
 * causes no model call outside `claude -p`, so nothing else is ever charged.
 */
export type UsageSource = "run"

/**
 * One charge against a person's daily budget (plan 5.2 `usage`, 5.7). Model calls only:
 * reminders, renewals and the price tracker make none and never appear here. `costUsd` is the
 * CLI's list-price estimate, a proxy under the subscription; `calls` is the hard count (5.12).
 */
export interface Usage {
  id: string
  userId: string
  /** The task it paid for, so a spend rolls up per task (plan 5.2); null outside any task. */
  taskId: string | null
  /** The run it paid for, or null for a charge a host records outside a run. */
  occurrenceId: string | null
  source: UsageSource
  calls: number
  costUsd: number
  at: string
}

/**
 * How one recipient's copy of a run's message stands (plan 5.5, "Delivery idempotency"). A row
 * is **owed** while `retryAt` is set -- `pending`, `deferred`, or `failed` with tries left -- and
 * final once it is null (`sent`, `unconfirmed`, `failed` for good). `claimed` is the moment of the
 * send: written before it, settled after.
 *
 * - `pending`: planned when the run fired; not tried yet.
 * - `claimed`: a send is out. Found still `claimed` later -- after a crash, or long after -- it
 *   may have gone out, so it is settled `unconfirmed`, never resent.
 * - `sent`: the Notifier returned the provider's message id.
 * - `deferred`: the Notifier said not now (`ExecutorUnavailableError`); nothing went out.
 * - `failed`: nothing went out (`DeliveryFailedError`). Retried with a backoff unless the person
 *   cannot be messaged at all or the attempts are spent; then final.
 * - `unconfirmed`: failed in a way that does not say whether it went out. Never resent; a host
 *   shows these to an admin.
 */
export type DeliveryStatus = "pending" | "claimed" | "sent" | "deferred" | "failed" | "unconfirmed"

/** One recipient's copy of one run: the delivery claim, owned by `delivery.ts`. */
export interface Delivery {
  occurrenceId: string
  userId: string
  status: DeliveryStatus
  /** The provider's message id, once `sent`. */
  messageId: string | null
  /** Why it failed, was deferred, or is unconfirmed. */
  error: string | null
  /** Failed sends with nothing sent; a deferral does not count one. */
  attempts: number
  /** Deferrals so far. */
  deferrals: number
  /** When it is next tried; null while claimed and once final. */
  retryAt: string | null
  createdAt: string
  claimedAt: string | null
  settledAt: string | null
}
