import { describe, expect, it } from "vitest"
import {
  createTask,
  invite,
  isOffSchedule,
  Lanes,
  RUN_NOW_PREFIX,
  reschedule,
  respondToInvite,
  runNowKey,
  type TaskType,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

/** A host's "run now" (rackbops-bot-plugins#369): an off-schedule run under `runNowKey`. */

const reminder: TaskType<{ text: string }> = {
  id: "reminder",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["once", "calendar"],
  run: async (ctx) => ({ notify: { text: ctx.config.text }, summary: ctx.config.text }),
}

async function setup() {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const folks = await people(store)
  const lanes = new Lanes({ store, clock, types: { reminder }, notifier })
  // Daily at 09:00 in Larry's zone, the first run tomorrow: nothing is due now.
  const start = new Date(Date.parse(T0) + 86_400_000).toISOString().slice(0, 10)
  const { task } = await createTask(
    store,
    actor(folks.larry),
    folks.larry,
    {
      type: reminder,
      title: "pills",
      config: { text: "pills" },
      schedule: { kind: "calendar", every: 1, unit: "day", start },
    },
    clock.now(),
  )
  return { store, clock, notifier, lanes, task, ...folks }
}

describe("a run now", () => {
  it("is keyed by its task and request, and is off the schedule", () => {
    expect(runNowKey("t1", "r-1")).toBe(`${RUN_NOW_PREFIX}t1:r-1`)
    expect(isOffSchedule(runNowKey("t1", "r-1"))).toBe(true)
    expect(isOffSchedule("sched:t1:2026-03-02T12:00:00.000Z")).toBe(false)
  })

  it("takes only a plain request id, so no two requests share a key", () => {
    for (const bad of ["", "a:b", "a b", "x".repeat(65)])
      expect(() => runNowKey("t1", bad)).toThrow()
    expect(runNowKey("t1", "x".repeat(64))).toBe(`now:t1:${"x".repeat(64)}`)
  })

  it("runs and sends to the owner and each accepted recipient on the next tick, and leaves the schedule's next run where it was", async () => {
    const { store, clock, notifier, lanes, task, larry, moe } = await setup()
    await invite(store, actor(larry), task, moe.id, clock.now())
    await respondToInvite(store, task, moe.id, "accept", clock.now())
    const before = await store.listOccurrences({ taskId: task.id, status: "queued" })
    expect(before).toHaveLength(1)
    const next = before[0]?.dueAt
    const made = await store.createOccurrence({
      taskId: task.id,
      lane: "notify",
      dueAt: clock.now().toISOString(),
      dedupeKey: runNowKey(task.id, "r1"),
      at: clock.now().toISOString(),
    })
    // The same request again queues nothing more.
    expect(
      await store.createOccurrence({
        taskId: task.id,
        lane: "notify",
        dueAt: clock.now().toISOString(),
        dedupeKey: runNowKey(task.id, "r1"),
        at: clock.now().toISOString(),
      }),
    ).toBeNull()
    expect(made).not.toBeNull()
    expect(await lanes.tickNotify()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(notifier.sent.map((s) => [s.userId, s.message.text]).sort()).toEqual(
      [
        [larry.id, "pills"],
        [moe.id, "pills"],
      ].sort(),
    )
    const queued = await store.listOccurrences({ taskId: task.id, status: "queued" })
    expect(queued.map((o) => [o.dueAt, o.dedupeKey.split(":")[0]])).toEqual([[next, "sched"]])
    expect((await store.getTask(task.id))?.status).toBe("active")
  })

  it("survives a schedule edit, which replaces only the scheduled run, as a snooze's run does", async () => {
    const { store, clock, task, larry } = await setup()
    await store.createOccurrence({
      taskId: task.id,
      lane: "notify",
      dueAt: clock.now().toISOString(),
      dedupeKey: runNowKey(task.id, "r1"),
      at: clock.now().toISOString(),
    })
    const current = await store.getTask(task.id)
    if (!current) throw new Error("no task")
    const start = new Date(Date.parse(T0) + 2 * 86_400_000).toISOString().slice(0, 10)
    await reschedule(
      store,
      current,
      larry,
      { kind: "calendar", every: 1, unit: "day", start },
      larry.id,
      clock.now(),
    )
    const queued = await store.listOccurrences({ taskId: task.id, status: "queued" })
    expect(queued.map((o) => o.dedupeKey.split(":")[0]).sort()).toEqual(["now", "sched"])
    // The scheduled run is the edit's: its first day is the new start, not the old one.
    const sched = queued.find((o) => o.dedupeKey.startsWith("sched:"))
    expect(sched?.dueAt.slice(0, 10)).toBe(start)
  })
})
