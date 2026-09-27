import { describe, expect, it } from "vitest"

import { createTask, materialize, reschedule, type Schedule } from "../src/index.js"
import { actor, FakeClock, MemoryStore, people, T0 } from "./helpers.js"

const type = {
  id: "reminder",
  lane: "notify" as const,
  capabilities: ["notify" as const],
  schedule: ["once" as const, "calendar" as const],
  run: async () => ({}),
}
const daily: Schedule = { kind: "calendar", every: 1, unit: "day", start: "2026-03-01" }

describe("materialization", () => {
  it("keeps exactly one upcoming occurrence, however often it is asked", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0)) // 07:00 EST on 2026-03-02
    const { larry } = await people(store)
    const { task, next } = await createTask(
      store,
      actor(larry),
      larry,
      { type, title: "t", config: {}, schedule: daily },
      clock.now(),
    )
    expect(next?.dueAt).toBe("2026-03-02T14:00:00.000Z") // 09:00 EST today
    expect(await materialize(store, task, larry, clock.now())).toBeNull()
    expect(await materialize(store, task, larry, clock.now())).toBeNull()
    expect(await store.listOccurrences({ taskId: task.id })).toHaveLength(1)
  })

  it("leaves no stale occurrence behind a schedule edit", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type, title: "t", config: {}, schedule: daily },
      clock.now(),
    )
    const evening: Schedule = { ...daily, hour: 18 }
    const result = await reschedule(store, task, larry, evening, larry.id, clock.now())
    expect(result.removed).toBe(1)
    const remaining = await store.listOccurrences({ taskId: task.id })
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.dueAt).toBe("2026-03-02T23:00:00.000Z")
    const history = await store.listTaskEvents(task.id)
    expect(history.map((h) => h.kind)).toEqual(["created", "schedule_changed"])
  })

  it("materializes a missed once schedule so it fires late rather than never", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    const past: Schedule = { kind: "once", at: "2026-03-02T10:00:00.000Z" }
    const { next } = await createTask(
      store,
      actor(larry),
      larry,
      { type, title: "t", config: {}, schedule: past },
      clock.now(),
    )
    expect(next?.dueAt).toBe(past.at)
  })

  it("refuses a schedule kind the type does not accept, and a broken schedule", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    const onceOnly = { ...type, schedule: ["once" as const] }
    await expect(
      createTask(
        store,
        actor(larry),
        larry,
        { type: onceOnly, title: "t", config: {}, schedule: daily },
        clock.now(),
      ),
    ).rejects.toThrow(/does not accept a calendar schedule/)
    await expect(
      createTask(
        store,
        actor(larry),
        larry,
        { type, title: "t", config: {}, schedule: { ...daily, every: 0 } },
        clock.now(),
      ),
    ).rejects.toThrow(/every/)
  })
})
