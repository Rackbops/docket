import { describe, expect, it } from "vitest"

import { createTask } from "../src/index.js"
import { actor } from "./helpers.js"
import { setup } from "./run-helpers.js"

describe("a text reply (docket#54)", () => {
  it("never lets a recipient's text end or snooze the owner's task", async () => {
    const { store, clock, lanes, task, type, runId, share, moe, larry } = await setup()
    await share(moe)
    await lanes.tickNotify()
    const id = await runId()
    type.onReply = async (ctx) => ({
      complete: true,
      snoozeUntil: new Date(ctx.now.getTime() + 3_600_000),
      summary: "acted",
    })
    const text = (userId: string) =>
      lanes.reply({ taskId: task.id, occurrenceId: id, userId, kind: "text", payload: "hi" })
    const outcome = await text(moe.id)
    expect(outcome).toEqual({ summary: "acted" })
    expect((await store.getTask(task.id))?.status).toBe("active")
    const queued = await store.listOccurrences({ taskId: task.id, status: "queued" })
    expect(queued.filter((o) => o.originalDueAt)).toEqual([])
    // The owner's text still does what the type says.
    clock.advance(1)
    await text(larry.id)
    expect((await store.getTask(task.id))?.status).toBe("done")
  })

  it("never hands a type another task's run", async () => {
    const { store, clock, lanes, task, type, larry } = await setup()
    const { task: other } = await createTask(
      store,
      actor(larry),
      larry,
      {
        type,
        title: "other",
        config: {},
        schedule: { kind: "once", at: clock.now().toISOString() },
      },
      clock.now(),
    )
    await lanes.tickNotify()
    const otherRun = (await store.listOccurrences({ taskId: other.id }))[0]?.id ?? ""
    expect(otherRun).not.toBe("")
    let called = 0
    type.onReply = async () => {
      called++
      return { complete: true }
    }
    const outcome = await lanes.reply({
      taskId: task.id,
      occurrenceId: otherRun,
      userId: larry.id,
      kind: "text",
      payload: "hi",
    })
    expect(outcome).toBeNull()
    expect(called).toBe(0)
    expect((await store.getTask(task.id))?.status).toBe("active")
  })
})
