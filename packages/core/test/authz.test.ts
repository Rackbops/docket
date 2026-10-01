import { describe, expect, it } from "vitest"

import {
  createTask,
  invite,
  respondToInvite,
  visibleSeries,
  visibleTask,
  visibleTasks,
} from "../src/index.js"
import { actor, FakeClock, MemoryStore, people, T0 } from "./helpers.js"

const type = {
  id: "reminder",
  lane: "notify" as const,
  capabilities: ["notify" as const],
  schedule: ["once" as const],
  run: async () => ({}),
}

describe("authorized reads", () => {
  it("never returns user B's task to user A", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry, moe, admin } = await people(store)
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type, title: "dentist", config: { text: "dentist" }, schedule: null },
      clock.now(),
    )

    expect(await visibleTask(store, actor(moe), task.id)).toBeNull()
    expect(await visibleTasks(store, actor(moe))).toEqual([])
    expect((await visibleTask(store, actor(larry), task.id))?.id).toBe(task.id)
    expect((await visibleTask(store, actor(admin), task.id))?.id).toBe(task.id)
  })

  it("gives a recipient the task without its config and state; owner and admins see them", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry, moe, admin } = await people(store)
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type, title: "q", config: { question: "private" }, schedule: null },
      clock.now(),
    )
    // A research request's rejected draft lives in its state.
    await store.updateTask(task.id, { state: { draft: "rejected draft" }, at: T0 })
    await invite(store, actor(larry), task, moe.id, clock.now())
    await respondToInvite(store, task, moe.id, "accept", clock.now())
    const seen = await visibleTask(store, actor(moe), task.id)
    expect([seen?.id, seen?.title, seen?.config, seen?.state]).toEqual([task.id, "q", null, null])
    expect((await visibleTasks(store, actor(moe))).map((t) => [t.config, t.state])).toEqual([
      [null, null],
    ])
    for (const who of [larry, admin]) {
      const whole = await visibleTask(store, actor(who), task.id)
      expect([whole?.config, whole?.state]).toEqual([
        { question: "private" },
        { draft: "rejected draft" },
      ])
    }
  })

  it("keeps a task's series -- prices seen, amounts paid -- behind the same rule", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry, moe } = await people(store)
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type, title: "widget", config: {}, schedule: null },
      clock.now(),
    )
    await store.addSeriesPoint({ taskId: task.id, at: T0, value: 49.99, unit: "USD" })
    await store.addSeriesPoint({ taskId: task.id, at: "2026-03-03T12:00:00.000Z", value: 44.99 })
    expect(await visibleSeries(store, actor(moe), task.id)).toBeNull()
    expect((await visibleSeries(store, actor(larry), task.id))?.map((p) => p.value)).toEqual([
      49.99, 44.99,
    ])
    expect((await visibleSeries(store, actor(larry), task.id, { limit: 1 }))?.[0]?.value).toBe(
      44.99,
    )
  })

  it("shows a task to a recipient only once they accepted", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry, moe } = await people(store)
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type, title: "dentist", config: {}, schedule: null },
      clock.now(),
    )

    expect((await invite(store, actor(larry), task, moe.id, clock.now())).ok).toBe(true)
    expect(await visibleTask(store, actor(moe), task.id)).toBeNull()
    await respondToInvite(store, task, moe.id, "accept", clock.now())
    expect((await visibleTask(store, actor(moe), task.id))?.id).toBe(task.id)
  })
})
