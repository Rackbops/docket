import type { Capability } from "./capabilities.js"
import type { JobResult, JobSpec } from "./job.js"
import type { Lane } from "./lanes.js"
import type {
  ConsentState,
  Delivery,
  DeliveryStatus,
  EventType,
  InviteBlock,
  Occurrence,
  OccurrenceEvent,
  OccurrenceStatus,
  Reply,
  ReplyKind,
  RunRecord,
  SeriesPoint,
  StoredFinding,
  Task,
  TaskEvent,
  TaskEventKind,
  TaskRecipient,
  TaskStatus,
  Usage,
  UsageSource,
  User,
} from "./model.js"
import type { Schedule } from "./schedule.js"

/**
 * The ports (plan section 5.1): everything the core needs from the outside world, as interfaces a
 * host implements. The host is the Rackbops tracker plugin on rackbops-discord-bot (plan rev17,
 * items 36 to 40): it supplies the SQLite store with people in it, Discord DMs, the clock, a
 * fenced fetch, and an Executor that submits model Jobs to city-hall, which only runs them
 * through the runner (plan 5.12). The tests supply in-memory fakes. Nothing in the core imports a
 * platform.
 */

export interface Clock {
  now(): Date
}

/** Who is acting: the tracker's user id and the tracker's own admin flag (plan 5.8, 5.10). */
export interface Actor {
  userId: string
  admin: boolean
}

/** Resolves a Discord user to the tracker's user, from the tracker's own store (plan 5.8). */
export interface Identity {
  actorForDiscord(discordId: string): Promise<Actor | null>
}

export interface OutgoingMessage {
  text: string
  /** Replies the message offers as buttons; the adapter renders them (discord-ai#7). */
  actions?: ReplyKind[]
  /**
   * When `actions` includes `decision`: the choices, one button each. The reply is a
   * `decision` whose payload is `{ choice }`.
   */
  decisions?: string[]
  /**
   * What a reply to this message answers. The dispatcher sets it on every delivery; the
   * Notifier encodes it into each button with `encodeReplyRef`, so a press routes back.
   */
  ref?: MessageRef
}

/** The task a message is about, and the occurrence when it is about one run. */
export interface MessageRef {
  taskId: string
  occurrenceId: string | null
}

/**
 * Sends to a user, never to a channel, at tier 0 (plan 5.5). How a send fails says what `deliver`
 * does next: `DeliveryFailedError` when nothing went out -- failed for good at once when
 * `unreachable`, else retried with a backoff up to a limit; `ExecutorUnavailableError` to defer
 * the send (not now, nothing went out, no attempt counted; retried with a backoff up to its own
 * limit); any other error when the send may have gone out (unconfirmed, never resent). A Notifier
 * keeps no claim of its own: `deliver` claims each send in the Store before it calls `sendDm`.
 */
export interface Notifier {
  sendDm(userId: string, message: OutgoingMessage): Promise<{ messageId: string }>
}

/**
 * Thrown by a Notifier when a send failed and nothing went out: the message can be sent again.
 * `unreachable` says the person cannot be messaged at all (DMs closed, left the server, the bot
 * blocked) -- what a host's pause-after-three rule counts (plan 5.5, item 49).
 */
export class DeliveryFailedError extends Error {
  override name = "DeliveryFailedError"
  constructor(
    message: string,
    readonly unreachable = false,
  ) {
    super(message)
  }
}

/**
 * Runs one Job through the runner and returns what came back (plan 5.12). A runner takes
 * minutes, so an Executor need not wait: it may submit the Job and throw `JobPendingError`, and
 * the execute lane asks again on its next tick with the same `jobKey`. So `run` must be
 * idempotent per `jobKey` -- submitting a key it has seen answers that Job (pending, or its
 * result), never a second model call; city-hall's execute lane is, by `key`.
 *
 * `jobKey` is the occurrence id for a run's first Job. After a usage limit the run is requeued
 * and its next try is a fresh Job, `<occurrence id>:<n>` for the n-th retry, since the old key's
 * answer is the usage limit for good. Any other requeue (pending, runtime unavailable, a crash
 * before the outcome was recorded) asks again under the same key and gets the same Job back.
 */
export interface Executor {
  run(spec: JobSpec, occurrenceId: string, jobKey: string): Promise<JobResult>
}

/**
 * Thrown by an Executor whose Job is submitted but not finished: nothing to record yet. The run
 * goes back to the queue unstarted and uncharged, the lane stops for this tick (Jobs run one at
 * a time, plan 5.3), and the next tick asks again under the same key -- past the budget check,
 * since the Job is already out, and with no new events.
 */
export class JobPendingError extends Error {
  override name = "JobPendingError"
}

/**
 * Thrown by an Executor whose runtime is not there; the lane skips, it never fails the item. From
 * a Notifier it defers one send: nothing went out, and the run finishes its delivery later.
 */
export class ExecutorUnavailableError extends Error {
  override name = "ExecutorUnavailableError"
}

export interface FetchResponse {
  status: number
  body: string
  headers: Record<string, string>
}

/** Plain HTTP reads for the plain-code types (price, market adapters). */
export interface Fetch {
  get(url: string, headers?: Record<string, string>): Promise<FetchResponse>
}

// --- Store ---------------------------------------------------------------------------------

export interface NewUser {
  discordId?: string | null
  displayName?: string | null
  timeZone?: string
  preferredHour?: number
  admin?: boolean
  at: string
}

export interface UserPatch {
  discordId?: string | null
  displayName?: string | null
  timeZone?: string
  preferredHour?: number
  admin?: boolean
}

export interface UserFilter {
  admin?: boolean
}

export interface NewTask {
  ownerId: string
  type: string
  title: string
  config: unknown
  /** Initial type state; null when absent. */
  state?: unknown
  schedule: Schedule | null
  lane: Lane
  capabilities: Capability[]
  at: string
}

export interface TaskPatch {
  title?: string
  config?: unknown
  state?: unknown
  schedule?: Schedule | null
  capabilities?: Capability[]
  status?: TaskStatus
  at: string
}

export interface TaskFilter {
  ownerId?: string
  status?: TaskStatus
  type?: string
}

export interface NewOccurrence {
  taskId: string
  lane: Lane
  dueAt: string
  dedupeKey: string
  at: string
}

export interface OccurrencePatch {
  status?: OccurrenceStatus
  startedAt?: string | null
  finishedAt?: string | null
  late?: boolean
  summary?: string | null
  costUsd?: number | null
  error?: string | null
  record?: RunRecord | null
}

export interface OccurrenceFilter {
  taskId?: string
  lane?: Lane
  status?: OccurrenceStatus
  /** Inclusive: occurrences due at or before this instant. */
  dueBefore?: string
}

export interface NewEvent {
  occurrenceId: string
  agent: string
  type: EventType
  text: string
  at: string
}

export interface NewTaskEvent {
  taskId: string
  actorId: string | null
  kind: TaskEventKind
  detail: string
  at: string
}

export interface NewReply {
  occurrenceId: string | null
  taskId: string
  userId: string
  kind: ReplyKind
  payload: unknown
  at: string
}

export interface NewBlock {
  ownerId: string
  recipientId: string
  expiresAt: string | null
  declineReplyId: string | null
  at: string
}

export interface NewSeriesPoint {
  taskId: string
  at: string
  value: number
  unit?: string | null
  note?: string | null
  /** A point with a key already stored is not added again (`SeriesPoint.key`). */
  key?: string | null
}

export interface SeriesFilter {
  /** Inclusive: points at or after this instant. */
  since?: string
  /** Keep only the most recent N points (the result stays oldest first). */
  limit?: number
}

export interface NewUsage {
  userId: string
  taskId: string | null
  occurrenceId: string | null
  source: UsageSource
  calls: number
  costUsd: number
  at: string
}

export interface NewFinding {
  taskId: string
  ownerId: string
  occurrenceId: string | null
  /** A finding with a key already stored is not added again (`StoredFinding.key`). */
  key?: string | null
  type: string
  text: string
  tags?: string[]
  source?: string | null
  at: string
}

export interface FindingFilter {
  taskId?: string
  ownerId?: string
  /** Inclusive: findings at or after this instant. */
  since?: string
}

export interface DeliveryFilter {
  occurrenceId?: string
  userId?: string
  status?: DeliveryStatus
  /** Inclusive: owed rows whose `retryAt` is at or before this instant. */
  dueBefore?: string
}

/** What settling a claim writes; every field is written, so an absent detail clears it. */
export interface DeliverySettle {
  status: Exclude<DeliveryStatus, "claimed">
  messageId?: string | null
  error?: string | null
  attempts: number
  deferrals: number
  /** When to try again; null makes the row final. */
  retryAt: string | null
  at: string
}

export interface UsageFilter {
  userId?: string
  /** Inclusive: charges at or after this instant. */
  since?: string
  /** Exclusive: charges before this instant. */
  before?: string
}

/**
 * Persistence. Every method is async so a host may back it with anything; the in-memory
 * `MemoryStore` is the reference for the semantics a host must keep, above all that
 * `createOccurrence` is a no-op on a known dedupe key.
 */
export interface Store {
  getUser(id: string): Promise<User | null>
  findUserByDiscordId(discordId: string): Promise<User | null>
  createUser(user: NewUser): Promise<User>
  updateUser(id: string, patch: UserPatch): Promise<User>
  /** In creation order. */
  listUsers(filter?: UserFilter): Promise<User[]>

  createTask(task: NewTask): Promise<Task>
  getTask(id: string): Promise<Task | null>
  listTasks(filter?: TaskFilter): Promise<Task[]>
  updateTask(id: string, patch: TaskPatch): Promise<Task>

  listRecipients(taskId: string): Promise<TaskRecipient[]>
  setRecipient(
    taskId: string,
    userId: string,
    state: ConsentState,
    at: string,
  ): Promise<TaskRecipient>
  removeRecipient(taskId: string, userId: string): Promise<void>

  listBlocks(ownerId: string, recipientId: string): Promise<InviteBlock[]>
  getBlock(id: string): Promise<InviteBlock | null>
  createBlock(block: NewBlock): Promise<InviteBlock>
  liftBlock(id: string, adminId: string, at: string): Promise<InviteBlock>

  /** Null when an occurrence with this dedupe key already exists. */
  createOccurrence(occurrence: NewOccurrence): Promise<Occurrence | null>
  getOccurrence(id: string): Promise<Occurrence | null>
  /** Ordered by due instant, then creation. */
  listOccurrences(filter?: OccurrenceFilter): Promise<Occurrence[]>
  updateOccurrence(id: string, patch: OccurrencePatch): Promise<Occurrence>
  /**
   * Deletes the occurrence if it is still `queued`; true when it did. A schedule edit cancels and
   * replaces through it (`reschedule`), one row at a time, so a snooze's run survives.
   */
  deleteOccurrence(id: string): Promise<boolean>
  /**
   * Compare-and-set: applies `patch` only while the row's status is `expected`, and returns the
   * row as patched, or null -- changing nothing -- when it is not. Atomic, so two lanes or two
   * overlapping ticks never both start one run.
   */
  updateOccurrenceIf(
    id: string,
    expected: OccurrenceStatus,
    patch: OccurrencePatch,
  ): Promise<Occurrence | null>
  /**
   * Work left running by a crash goes back to the queue on start, fully unstarted: status
   * `queued`, `startedAt` null (its `record`, if any, is kept). Returns the ids.
   */
  requeueRunning(lane?: Lane): Promise<string[]>

  addEvent(event: NewEvent): Promise<OccurrenceEvent>
  /** Oldest first; `after` is the last event id already seen. */
  listEvents(occurrenceId: string, after?: string): Promise<OccurrenceEvent[]>
  addTaskEvent(event: NewTaskEvent): Promise<TaskEvent>
  listTaskEvents(taskId: string): Promise<TaskEvent[]>
  addReply(reply: NewReply): Promise<Reply>
  /** Oldest first. */
  listReplies(taskId: string): Promise<Reply[]>

  addSeriesPoint(point: NewSeriesPoint): Promise<SeriesPoint>
  /** Oldest first. */
  listSeries(taskId: string, filter?: SeriesFilter): Promise<SeriesPoint[]>

  /**
   * Stores one finding. With a key already stored it adds nothing and returns the stored one, so a
   * run's outcome applied twice stores each finding once.
   */
  addFinding(finding: NewFinding): Promise<StoredFinding>
  /** Oldest first (by `at`, then insertion). */
  listFindings(filter?: FindingFilter): Promise<StoredFinding[]>
  /** Forget-me: deletes every finding of the tasks this person owns. Returns how many. */
  deleteFindings(ownerId: string): Promise<number>

  addUsage(usage: NewUsage): Promise<Usage>
  /** Oldest first. */
  listUsage(filter?: UsageFilter): Promise<Usage[]>

  /**
   * An exactly-once claim (plan 5.5's digest claim, 5.7's one DM): true the first time a key is
   * claimed, false on every later call with the same key, across restarts.
   */
  claimNotice(key: string, at: string): Promise<boolean>

  /**
   * Plans one recipient's copy of a run when it fires: a `pending` row owed from `at` (`retryAt`
   * = `at`), no attempts or deferrals. Null -- changing nothing -- when the row exists, so
   * planning twice is a no-op.
   */
  planDelivery(occurrenceId: string, userId: string, at: string): Promise<Delivery | null>
  /**
   * Claims an owed row (`retryAt` set) before its send: status `claimed`, `claimedAt` = `at`,
   * `retryAt` null, the rest kept. Null -- changing nothing -- when there is no row or it is not
   * owed. Atomic: two callers never both get the claim.
   */
  claimDelivery(occurrenceId: string, userId: string, at: string): Promise<Delivery | null>
  /** Writes a row's outcome (`settledAt` = `settle.at`). Throws when there is no row. */
  settleDelivery(occurrenceId: string, userId: string, settle: DeliverySettle): Promise<Delivery>
  /** Oldest row first (by `createdAt`, then insertion). */
  listDeliveries(filter?: DeliveryFilter): Promise<Delivery[]>
  /** Forget-me: deletes every delivery row for this person. Returns how many. */
  deleteDeliveries(userId: string): Promise<number>
}
