import { describe, expect, it } from "vitest"

import { createTask, invite, respondToInvite, visibleTask, visibleTasks } from "../src/index.js"
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
