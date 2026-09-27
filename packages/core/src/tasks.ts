import { CAPABILITY_TIER, type Capability } from "./capabilities.js"
import type { TaskType } from "./contract.js"
import type { Occurrence, Task, User } from "./model.js"
import type { Actor, Store } from "./ports.js"
import { type Schedule, scheduleProblems } from "./schedule.js"
import { materialize, ScheduleError } from "./scheduler.js"

/**
 * Creating a task (plan sections 5.2, 5.6). The lane comes from the type; the capabilities a new
 * task holds are the type's tier-0 ones -- tier 1 is granted by an admin (E7), never by creation.
 */

export interface NewTaskInput<Config> {
  type: TaskType<Config>
  title: string
  config: Config
  schedule: Schedule | null
}

export interface CreatedTask {
  task: Task
  next: Occurrence | null
}

export class TaskError extends Error {
  override name = "TaskError"
}

/** The type's tier-0 capabilities: what a task may do before any grant. */
export function defaultCapabilities(type: TaskType<unknown>): Capability[] {
  return type.capabilities.filter((c) => CAPABILITY_TIER[c] === 0)
}

export async function createTask<Config>(
  store: Store,
  actor: Actor,
  owner: User,
  input: NewTaskInput<Config>,
  now: Date,
): Promise<CreatedTask> {
  if (!actor.admin && actor.userId !== owner.id) {
    throw new TaskError("only the owner or an admin creates a task for a person")
  }
  if (input.schedule) {
    if (!input.type.schedule.includes(input.schedule.kind)) {
      throw new ScheduleError(`${input.type.id} does not accept a ${input.schedule.kind} schedule`)
    }
    const problems = scheduleProblems(input.schedule)
    if (problems.length > 0) throw new ScheduleError(problems.join("; "))
  }
  const at = now.toISOString()
  const task = await store.createTask({
    ownerId: owner.id,
    type: input.type.id,
    title: input.title,
    config: input.config,
    schedule: input.schedule,
    lane: input.type.lane,
    capabilities: defaultCapabilities(input.type as TaskType<unknown>),
    at,
  })
  await store.addTaskEvent({
    taskId: task.id,
    actorId: actor.userId,
    kind: "created",
    detail: input.type.id,
    at,
  })
  return { task, next: await materialize(store, task, owner, now) }
}
