import type {
  Delivery,
  Occurrence,
  OccurrenceEvent,
  Reply,
  SeriesPoint,
  Task,
  TaskEvent,
  TaskEventKind,
  TaskRecipient,
} from "./model.js"
import type { Actor, SeriesFilter, Store, TaskFilter } from "./ports.js"

/**
 * Authorization as a core rule (plan section 5.10): every read of a task, its occurrences,
 * events, replies and history takes an identity and returns only what that identity may see --
 * the owner, a recipient who accepted, or an admin. A host serves these, never the Store directly.
 */

/** True when `actor` may see `task`, given the task's recipients. */
export function canSee(actor: Actor, task: Task, recipients: readonly TaskRecipient[]): boolean {
  if (actor.admin || task.ownerId === actor.userId) return true
  return recipients.some((r) => r.userId === actor.userId && r.state === "accepted")
}

/** The task, or null when it does not exist or the actor may not see it (indistinguishable). */
export async function visibleTask(
  store: Store,
  actor: Actor,
  taskId: string,
): Promise<Task | null> {
  const task = await store.getTask(taskId)
  if (!task) return null
  return canSee(actor, task, await store.listRecipients(taskId)) ? task : null
}

/** Tasks the actor may see; an admin sees every task the filter matches. */
export async function visibleTasks(
  store: Store,
  actor: Actor,
  filter: TaskFilter = {},
): Promise<Task[]> {
  const tasks = await store.listTasks(filter)
  if (actor.admin) return tasks
  const out: Task[] = []
  for (const task of tasks) {
    if (canSee(actor, task, await store.listRecipients(task.id))) out.push(task)
  }
  return out
}

/** Whether `actor` sees the whole of a task's runs: its owner or an admin, not a recipient. */
function seesAll(actor: Actor, task: Task): boolean {
  return actor.admin || task.ownerId === actor.userId
}

/**
 * The task's runs. A recipient sees each run without its `record` -- the outcome as stored, the
 * type's state among it -- which is for the owner and admins (plan 5.10).
 */
export async function visibleOccurrences(
  store: Store,
  actor: Actor,
  taskId: string,
): Promise<Occurrence[] | null> {
  const task = await visibleTask(store, actor, taskId)
  if (!task) return null
  const runs = await store.listOccurrences({ taskId })
  return seesAll(actor, task) ? runs : runs.map((o) => ({ ...o, record: null }))
}

/**
 * A run's events. A recipient does not see a `delivered` line naming anyone else (rows from
 * before 0.4.0; since then who receives a run is in its deliveries, never in the events).
 */
export async function visibleEvents(
  store: Store,
  actor: Actor,
  occurrenceId: string,
  after?: string,
): Promise<OccurrenceEvent[] | null> {
  const occurrence = await store.getOccurrence(occurrenceId)
  const task = occurrence ? await visibleTask(store, actor, occurrence.taskId) : null
  if (!task) return null
  const events = await store.listEvents(occurrenceId, after)
  if (seesAll(actor, task)) return events
  return events.filter((e) => e.type !== "delivered" || e.text.split(" ")[0] === actor.userId)
}

/** A run's deliveries: every row for the owner and admins, a recipient's own row for them. */
export async function visibleDeliveries(
  store: Store,
  actor: Actor,
  occurrenceId: string,
): Promise<Delivery[] | null> {
  const occurrence = await store.getOccurrence(occurrenceId)
  const task = occurrence ? await visibleTask(store, actor, occurrence.taskId) : null
  if (!task) return null
  const rows = await store.listDeliveries({ occurrenceId })
  return seesAll(actor, task) ? rows : rows.filter((d) => d.userId === actor.userId)
}

/**
 * The task's replies: all of them for the owner and admins, a recipient's own for them -- one
 * recipient never learns from a reply who else receives the task (plan 5.10).
 */
export async function visibleReplies(
  store: Store,
  actor: Actor,
  taskId: string,
): Promise<Reply[] | null> {
  const task = await visibleTask(store, actor, taskId)
  if (!task) return null
  const replies = await store.listReplies(taskId)
  return seesAll(actor, task) ? replies : replies.filter((r) => r.userId === actor.userId)
}

/**
 * History kinds about one recipient. Their `detail` starts with that recipient's id (then a
 * space, if anything follows), the shape `consent.ts` writes; a host writing one keeps it.
 */
const ABOUT_A_RECIPIENT: ReadonlySet<TaskEventKind> = new Set([
  "recipient_invited",
  "recipient_accepted",
  "recipient_declined",
  "recipient_opted_out",
  "recipient_removed",
  "blocked",
  "block_lifted",
])

/**
 * The task's history: all of it for the owner and admins. A recipient sees the task's own
 * events and, of those about a recipient (invites, answers, opt-outs, blocks), only their own.
 */
export async function visibleHistory(
  store: Store,
  actor: Actor,
  taskId: string,
): Promise<TaskEvent[] | null> {
  const task = await visibleTask(store, actor, taskId)
  if (!task) return null
  const events = await store.listTaskEvents(taskId)
  if (seesAll(actor, task)) return events
  return events.filter(
    (e) => !ABOUT_A_RECIPIENT.has(e.kind) || e.detail.split(" ")[0] === actor.userId,
  )
}

/** The task's series -- prices seen, amounts paid -- for those who may see the task. */
export async function visibleSeries(
  store: Store,
  actor: Actor,
  taskId: string,
  filter?: SeriesFilter,
): Promise<SeriesPoint[] | null> {
  if (!(await visibleTask(store, actor, taskId))) return null
  return store.listSeries(taskId, filter)
}
