import { type Capability, unknownCapabilities } from "./capabilities.js"
import type { JobResult, JobSpec } from "./job.js"
import { isLane, type Lane } from "./lanes.js"
import type { Occurrence, OccurrenceEvent, Reply, SeriesPoint, Task, User } from "./model.js"
import type { Fetch, Finding, OutgoingMessage } from "./ports.js"
import { isScheduleKind, type ScheduleKind } from "./schedule.js"

/**
 * The task-type contract (plan section 5.4). The dispatcher owns status; a type owns its events,
 * its state and what goes out. A notify-lane type implements `run`; an execute-lane type
 * implements `prepare` (config, state and history in, a Job as data out) and `finish` (the
 * JobResult in, findings and notifications out) and never calls a model itself.
 */

/** The ports a type may use directly; the host decides which exist (plan 5.1). */
export interface TypePorts {
  /** Plain HTTP reads, for the plain-code types. Absent when the host configured none. */
  fetch?: Fetch
}

export interface RunContext<Config = unknown> {
  task: Task
  occurrence: Occurrence
  /**
   * For a run a snooze queued: the due instant of the run it re-asks, following a chain of
   * snoozes back to the first. A type that reads meaning from the due instant (a renewal's
   * period date) reads this instead. Absent on any other run.
   */
  originalDueAt?: string
  owner: User
  /** Recipients who accepted, in addition to the owner. */
  recipients: User[]
  config: Config
  /** What the type's last `Outcome.state` said; null until it said anything. */
  state: unknown
  now: Date
  ports: TypePorts
  history: {
    events: OccurrenceEvent[]
    replies: Reply[]
    /** The task's most recent series points, oldest first. */
    series: SeriesPoint[]
  }
}

export interface ReplyContext<Config = unknown> extends RunContext<Config> {
  reply: Reply
}

/** One observation for the task's series; `at` defaults to now. */
export interface SeriesObservation {
  value: number
  unit?: string
  note?: string
  at?: string
}

export interface Outcome {
  /** Sent to the owner and every accepted recipient, idempotently per person. */
  notify?: OutgoingMessage
  /** One line for the occurrence's `summary`. */
  summary?: string
  /** Type state carried to the next run; the dispatcher stores it on the task when present. */
  state?: unknown
  /** Points the dispatcher appends to the task's series, in order. */
  series?: SeriesObservation[]
  /** The task is finished: no further occurrences; the dispatcher marks it done. */
  complete?: boolean
  /** From `onReply`: a snooze creates a new occurrence at this instant. */
  snoozeUntil?: Date
  /** Findings for the owner's memory (E7). */
  findings?: Finding[]
}

export interface IntakeOption {
  name: string
  description: string
  required: boolean
  kind: "string" | "integer" | "number" | "boolean" | "datetime"
}

/** The slash-command options, and the dialogue's fields (plan 1.4, E10). */
export interface IntakeSpec {
  options: IntakeOption[]
}

export interface TaskType<Config = unknown> {
  id: string
  lane: Lane
  /** What the type needs; only grantable (tier 0 and 1) names may appear. */
  capabilities: readonly Capability[]
  /** Which schedule kinds the type accepts. */
  schedule: readonly ScheduleKind[]
  /** Notify lane: do the work and say what goes out. */
  run?(ctx: RunContext<Config>): Promise<Outcome>
  /** Execute lane: the model call as data. */
  prepare?(ctx: RunContext<Config>): Promise<JobSpec>
  /** Execute lane: what the model's answer means. */
  finish?(ctx: RunContext<Config>, result: JobResult): Promise<Outcome>
  /** A reply: done, snooze or decision from the owner (`runRefusal`), text from anyone. */
  onReply?(ctx: ReplyContext<Config>): Promise<Outcome>
  intake?: IntakeSpec
}

export class TaskTypeError extends Error {
  override name = "TaskTypeError"
}

/**
 * Checks a type declaration at definition time and freezes it. A type that declares a capability
 * outside the grantable set, an unknown lane or schedule kind, or the wrong methods for its lane
 * never loads.
 */
export function defineTaskType<Config>(def: TaskType<Config>): TaskType<Config> {
  if (!def.id) throw new TaskTypeError("a task type needs an id")
  if (!isLane(def.lane)) throw new TaskTypeError(`${def.id}: unknown lane ${String(def.lane)}`)
  const unknown = unknownCapabilities(def.capabilities)
  if (unknown.length > 0) {
    throw new TaskTypeError(`${def.id}: declares ungrantable capabilities: ${unknown.join(", ")}`)
  }
  if (def.schedule.length === 0) throw new TaskTypeError(`${def.id}: accepts no schedule kind`)
  const badKinds = def.schedule.filter((k) => !isScheduleKind(k))
  if (badKinds.length > 0) {
    throw new TaskTypeError(`${def.id}: unknown schedule kinds: ${badKinds.join(", ")}`)
  }
  if (def.lane === "notify" && !def.run)
    throw new TaskTypeError(`${def.id}: a notify type needs run`)
  if (def.lane === "execute" && (!def.prepare || !def.finish)) {
    throw new TaskTypeError(`${def.id}: an execute type needs prepare and finish`)
  }
  return Object.freeze({ ...def })
}
