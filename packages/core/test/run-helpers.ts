import {
  createTask,
  DeliveryFailedError,
  invite,
  type LaneDeps,
  Lanes,
  type Notifier,
  respondToInvite,
  type Schedule,
  type TaskType,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

/**
 * Alerts once when a value it reads crosses below 10, and remembers that it did: the shape of
 * the price tracker, whose stored crossing would swallow a lost alert (plan item 58).
 */
export function crossing(read: () => number, runs: { n: number }): TaskType<unknown> {
  return {
    id: "crossing",
    lane: "notify",
    capabilities: ["notify"],
    schedule: ["poll", "calendar", "once"],
    run: async (ctx) => {
      runs.n++
      const value = read()
      const below = value < 10
      const was = (ctx.state as { below?: boolean } | null)?.below ?? false
      return {
        state: { below },
        series: [{ value }],
        // A snooze's run (it has an originalDueAt) asks again.
        ...(below && (!was || ctx.originalDueAt)
          ? { notify: { text: `dropped to ${value}`, actions: ["done", "snooze"] } }
          : {}),
        summary: String(value),
      }
    },
    onReply: async (ctx) => {
      if (ctx.reply.kind === "snooze") {
        return { snoozeUntil: new Date(ctx.now.getTime() + 3_600_000) }
      }
      return ctx.reply.kind === "done" && ctx.task.schedule?.kind === "once"
        ? { complete: true }
        : {}
    },
  }
}

export const quarterHourly: Schedule = { kind: "poll", every: 15, unit: "minute", start: T0 }

/** Records every attempt; sends to the users in `failFor` fail the way the test says. */
export class PickyNotifier extends FakeNotifier {
  readonly failFor = new Map<string, () => Error>()
  readonly attempts: string[] = []
  override async sendDm(userId: string, message: Parameters<Notifier["sendDm"]>[1]) {
    this.attempts.push(userId)
    const fail = this.failFor.get(userId)
    if (fail) throw fail()
    return super.sendDm(userId, message)
  }
}

/** The person cannot be messaged at all. */
export const closed = () => new DeliveryFailedError("recipient cannot be messaged", true)
/** Nothing went out this time; it may next time. */
export const flaky = () => new DeliveryFailedError("Discord said 500, not sent")

export async function setup(
  options: { schedule?: Schedule; value?: { v: number }; deps?: Partial<LaneDeps> } = {},
) {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new PickyNotifier()
  const folks = await people(store)
  const runs = { n: 0 }
  const value = options.value ?? { v: 5 }
  const type = crossing(() => value.v, runs)
  const lanes = new Lanes({ store, clock, types: { crossing: type }, notifier, ...options.deps })
  const { task } = await createTask(
    store,
    actor(folks.larry),
    folks.larry,
    { type, title: "widget", config: {}, schedule: options.schedule ?? quarterHourly },
    clock.now(),
  )
  const share = async (...users: { id: string }[]) => {
    for (const u of users) {
      await invite(store, actor(folks.larry), task, u.id, clock.now())
      await respondToInvite(store, task, u.id, "accept", clock.now())
    }
  }
  /** The task's first run. */
  const runId = async () => (await store.listOccurrences({ taskId: task.id }))[0]?.id ?? ""
  return { store, clock, notifier, lanes, task, type, runs, value, share, runId, ...folks }
}
