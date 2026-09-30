import { visibleTasks } from "./authz.js"
import { describeSchedule, formatInstant } from "./describe.js"
import type { Occurrence, Task, User } from "./model.js"
import type { Actor, OutgoingMessage, Store } from "./ports.js"
import { hasFired } from "./record.js"

/**
 * What the bot says in the first slice (plan sections 5.5, 5.10, E2): the disclosure at
 * registration, the consent DM, and the task list. The words live here so every host says the
 * same thing and a test pins it; a host only renders them.
 */

/** Told at `/register` and in every consent DM (plan 1.1, 5.5): admins see everything. */
export const ADMIN_DISCLOSURE =
  "An admin of this tracker can see every task and its history, including yours."

export interface RegistrationTextOptions {
  /** The first registration, rather than a later edit of the same settings. */
  first: boolean
  /** The host's own lines, after the disclosure: how its delivery pauses, say. */
  notes?: readonly string[]
}

/**
 * The reply to `/register` (plan 5.8): people live in the tracker's own store (item 40), so there
 * is no link to follow -- registering is the person's first contact, setting their preferred hour
 * and zone. It says when things arrive, and the disclosure (plan 1.1, 5.5).
 */
export function registrationText(user: User, options: RegistrationTextOptions): string {
  const hour = String(user.preferredHour).padStart(2, "0")
  return [
    options.first ? "You are registered." : "Your settings are updated.",
    `Reminders reach you by DM. One without a time of day arrives at ${hour}:00, ${user.timeZone} time.`,
    `Your tasks are private to you and anyone you choose to share them with. ${ADMIN_DISCLOSURE}`,
    ...(options.notes ?? []),
  ].join("\n")
}

function name(user: User): string {
  return user.displayName ?? "Someone"
}

/**
 * The one consent DM an invited person gets (plan 5.5): who, what, how often (see
 * `describeSchedule` for how the owner's times read in another zone),
 * that they only receive, that they can stop, and who else can see it. Accept and decline route
 * back through the task-level reference. With `now`, a one-off in another year says which.
 */
export function inviteMessage(
  task: Task,
  owner: User,
  recipient: User,
  now?: Date,
): OutgoingMessage {
  const cadence = task.schedule
    ? `, which runs ${describeSchedule(task.schedule, owner, recipient.timeZone, now)}`
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
    const queued = (await store.listOccurrences({ taskId: task.id, status: "queued" })).filter(
      (o) => !hasFired(o),
    )
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
      const schedule = task.schedule?.kind === "once" ? null : task.schedule
      const cadence = schedule
        ? `, ${describeSchedule(schedule, from ?? viewer, viewer.timeZone, now)}`
        : ""
      const owner = from ? ` (from ${name(from)})` : ""
      return `\`${task.id}\` ${task.title}${owner} -- ${when}${cadence}`
    })
    .join("\n")
}
