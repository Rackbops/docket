import type {
  Occurrence,
  OccurrenceEvent,
  Reply,
  SeriesPoint,
  Task,
  TaskEvent,
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

export async function visibleOccurrences(
  store: Store,
  actor: Actor,
  taskId: string,
): Promise<Occurrence[] | null> {
  if (!(await visibleTask(store, actor, taskId))) return null
  return store.listOccurrences({ taskId })
}

export async function visibleEvents(
  store: Store,
  actor: Actor,
  occurrenceId: string,
  after?: string,
): Promise<OccurrenceEvent[] | null> {
  const occurrence = await store.getOccurrence(occurrenceId)
  if (!occurrence || !(await visibleTask(store, actor, occurrence.taskId))) return null
  return store.listEvents(occurrenceId, after)
}

export async function visibleReplies(
  store: Store,
  actor: Actor,
  taskId: string,
): Promise<Reply[] | null> {
  if (!(await visibleTask(store, actor, taskId))) return null
  return store.listReplies(taskId)
}

export async function visibleHistory(
  store: Store,
  actor: Actor,
  taskId: string,
): Promise<TaskEvent[] | null> {
  if (!(await visibleTask(store, actor, taskId))) return null
  return store.listTaskEvents(taskId)
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
