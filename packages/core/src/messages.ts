import { visibleTasks } from "./authz.js"
import { describeSchedule, formatInstant } from "./describe.js"
import type { Occurrence, Task, User } from "./model.js"
import type { Actor, OutgoingMessage, Store } from "./ports.js"

/**
 * What the bot says in the first slice (plan sections 5.5, 5.10, E2): the disclosure at
 * registration, the consent DM, and the task list. The words live here so every host says the
 * same thing and a test pins it; a host only renders them.
 */

/** Told at `/register` and in every consent DM (plan 1.1, 5.5): admins see everything. */
export const ADMIN_DISCLOSURE =
  "An admin of this tracker can see every task and its history, including yours."

/** The `/register` reply, around usr's single-use link. */
export function registrationText(url: string): string {
  return [
    `Finish registering here (the link works once, for 15 minutes): ${url}`,
    `Your tasks are private to you and anyone you choose to share them with. ${ADMIN_DISCLOSURE}`,
  ].join("\n")
}

function name(user: User): string {
  return user.displayName ?? "Someone"
}

/**
 * The one consent DM an invited person gets (plan 5.5): who, what, how often in their own zone,
 * that they only receive, that they can stop, and who else can see it. Accept and decline route
 * back through the task-level reference.
 */
export function inviteMessage(task: Task, owner: User, recipient: User): OutgoingMessage {
  const cadence = task.schedule
    ? `, which runs ${describeSchedule(task.schedule, owner, recipient.timeZone)}`
    : ""
  return {
    text: [
      `${name(owner)} wants you to be notified about "${task.title}"${cadence}.`,
      "You would only receive its results; you can stop them from any message.",
      ADMIN_DISCLOSURE,
      "Do you accept these notifications?",
    ].join("\n"),
    actions: ["accept", "decline"],
    ref: { taskId: task.id, occurrenceId: null },
  }
}

export interface TaskListEntry {
  task: Task
  /** The next queued occurrence, or null when nothing is scheduled. */
  next: Occurrence | null
  /** The owner, when the viewer is a recipient rather than the owner. */
  from: User | null
}

/**
 * The viewer's active tasks -- their own and those they accepted -- each with its next run.
 * An admin sees only their own here too: `/tasks` is a person's list, not the admin view (5.10).
 */
export async function taskList(store: Store, actor: Actor): Promise<TaskListEntry[]> {
  const tasks = await visibleTasks(store, { ...actor, admin: false }, { status: "active" })
  const entries: TaskListEntry[] = []
  for (const task of tasks) {
    const queued = await store.listOccurrences({ taskId: task.id, status: "queued" })
    const from = task.ownerId === actor.userId ? null : await store.getUser(task.ownerId)
    entries.push({ task, next: queued[0] ?? null, from })
  }
  return entries.sort(
    (a, b) =>
      (a.next?.dueAt ?? "￿").localeCompare(b.next?.dueAt ?? "￿") ||
      a.task.title.localeCompare(b.task.title),
  )
}

/** The list as lines, soonest first, times in the viewer's zone. */
export function formatTaskList(entries: readonly TaskListEntry[], viewer: User, now: Date): string {
  if (entries.length === 0) return "You have no active tasks."
  return entries
    .map(({ task, next, from }) => {
      const when = next ? `next ${formatInstant(next.dueAt, viewer.timeZone, now)}` : "nothing due"
      const cadence = task.schedule
        ? `, ${describeSchedule(task.schedule, from ?? viewer, viewer.timeZone)}`
        : ""
      const owner = from ? ` (from ${name(from)})` : ""
      return `\`${task.id}\` ${task.title}${owner} -- ${when}${cadence}`
    })
    .join("\n")
}
