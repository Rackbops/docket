import type { Capability } from "./capabilities.js"
import type { JobResult, JobSpec } from "./job.js"
import type { Lane } from "./lanes.js"
import type {
  ConsentState,
  EventType,
  InviteBlock,
  Occurrence,
  OccurrenceEvent,
  OccurrenceStatus,
  Reply,
  ReplyKind,
  SeriesPoint,
  Task,
  TaskEvent,
  TaskEventKind,
  TaskRecipient,
  TaskStatus,
  User,
} from "./model.js"
import type { Schedule } from "./schedule.js"

/**
 * The ports (plan section 5.1): everything the core needs from the outside world, as interfaces a
 * host implements. city-hall supplies SQLite, usr, Discord through discord-ai, recall and the
 * runner; the tests supply in-memory fakes. Nothing in the core imports a platform.
 */

export interface Clock {
  now(): Date
}

/** Who is acting: the tracker's user id and whether usr says they hold `city-hall:admin`. */
export interface Actor {
  userId: string
  admin: boolean
}

/** Resolves the people usr knows to the tracker's users (plan 5.8, 5.10). */
export interface Identity {
  actorForDiscord(discordId: string): Promise<Actor | null>
  actorForSubject(usrSubject: string): Promise<Actor | null>
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
}

/** Sends to a user, never to a channel, at tier 0 (plan 5.5). */
export interface Notifier {
  sendDm(userId: string, message: OutgoingMessage): Promise<{ messageId: string }>
}

/** Runs one Job through the runner and returns what came back (plan 5.12). */
export interface Executor {
  run(spec: JobSpec, occurrenceId: string): Promise<JobResult>
}

/** Thrown by an Executor whose runtime is not there; the lane skips, it never fails the item. */
export class ExecutorUnavailableError extends Error {
  override name = "ExecutorUnavailableError"
}

export interface Finding {
  text: string
  tags?: string[]
  source?: string
}

/** A person's own pool in recall, written with a delegation token by the host (plan 5.9). */
export interface Memory {
  remember(ownerId: string, finding: Finding): Promise<{ id: string }>
  search(ownerId: string, query: string, limit?: number): Promise<Array<Finding & { id: string }>>
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
  usrSubject?: string | null
  displayName?: string | null
  timeZone?: string
  preferredHour?: number
  admin?: boolean
  at: string
}

export interface UserPatch {
  discordId?: string | null
  usrSubject?: string | null
  displayName?: string | null
  timeZone?: string
  preferredHour?: number
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
}

export interface SeriesFilter {
  /** Inclusive: points at or after this instant. */
  since?: string
  /** Keep only the most recent N points (the result stays oldest first). */
  limit?: number
}

/**
 * Persistence. Every method is async so a host may back it with anything; the in-memory
 * `MemoryStore` is the reference for the semantics a host must keep, above all that
 * `createOccurrence` is a no-op on a known dedupe key.
 */
export interface Store {
  getUser(id: string): Promise<User | null>
  findUserByDiscordId(discordId: string): Promise<User | null>
  findUserBySubject(usrSubject: string): Promise<User | null>
  createUser(user: NewUser): Promise<User>
  updateUser(id: string, patch: UserPatch): Promise<User>

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
  /** A schedule edit cancels and replaces: drop the task's queued occurrences. Returns how many. */
  deleteQueuedOccurrences(taskId: string): Promise<number>
  /** Work left running by a crash goes back to the queue on start. Returns the ids. */
  requeueRunning(lane?: Lane): Promise<string[]>

  addEvent(event: NewEvent): Promise<OccurrenceEvent>
  /** Oldest first; `after` is the last event id already seen. */
  listEvents(occurrenceId: string, after?: string): Promise<OccurrenceEvent[]>
  addTaskEvent(event: NewTaskEvent): Promise<TaskEvent>
  listTaskEvents(taskId: string): Promise<TaskEvent[]>
  addReply(reply: NewReply): Promise<Reply>
  listReplies(taskId: string): Promise<Reply[]>

  addSeriesPoint(point: NewSeriesPoint): Promise<SeriesPoint>
  /** Oldest first. */
  listSeries(taskId: string, filter?: SeriesFilter): Promise<SeriesPoint[]>
}
