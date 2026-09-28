import type { Capability } from "./capabilities.js"
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
  /** usr's user UUID (`nz_id.sub`), filled at registration or from `/allow`'s response. */
  usrSubject: string | null
  displayName: string | null
  /** IANA zone; usr's zone is the initial default, the tracker owns it afterwards. */
  timeZone: string
  /** Local hour (0-23) at which digests and daily outputs reach this person. */
  preferredHour: number
  /** Mirrors the usr role `city-hall:admin`. The one admin definition (plan 5.10). */
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

/** One due instance of a task: the generalization of city-hall's `work` row. */
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
  /**
   * Per-source identity: `sched:<task>:<due>`, `manual:<task>:<seq>`, `snooze:<occurrence>`,
   * `issue:<repo>:<n>:<wf>`.
   */
  dedupeKey: string
  summary: string | null
  costUsd: number | null
  error: string | null
  createdAt: string
}

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
  at: string
  value: number
  /** A currency code or other unit, when the value has one. */
  unit: string | null
  /** Why it was recorded: `observed`, `kept`, `renewed`, ... */
  note: string | null
}

/** Where a charge came from: a run on the runner, or recall's extraction for a finding. */
export type UsageSource = "run" | "recall"

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
