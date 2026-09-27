import { describe, expect, it } from "vitest"

import {
  createTask,
  type Executor,
  ExecutorUnavailableError,
  invite,
  issueKey,
  type JobResult,
  type JobSpec,
  Lanes,
  respondToInvite,
  type Schedule,
  type TaskType,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

const reminder: TaskType<{ text: string }> = {
  id: "reminder",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["once", "calendar"],
  run: async (ctx) => ({
    notify: { text: ctx.config.text, actions: ["done", "snooze"] },
    summary: ctx.config.text,
  }),
  onReply: async (ctx) =>
    ctx.reply.kind === "snooze" ? { snoozeUntil: new Date(ctx.now.getTime() + 3_600_000) } : {},
}

const research: TaskType<unknown> = {
  id: "research",
  lane: "execute",
  capabilities: ["notify"],
  schedule: ["once"],
  prepare: async () => ({ prompt: "look into it" }),
  finish: async (_ctx, result) => ({
    notify: { text: result.kind === "success" ? result.result : `failed: ${result.kind}` },
    summary: result.kind,
  }),
}

const types = { reminder: reminder as TaskType<unknown>, research }
const daily: Schedule = { kind: "calendar", every: 1, unit: "day", start: "2026-03-01" }

async function setup(executor?: Executor | null) {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const folks = await people(store)
  const lanes = new Lanes({ store, clock, types, notifier, executor: executor ?? null })
  return { store, clock, notifier, lanes, ...folks }
}

describe("two lanes", () => {
  it("never lets a queued agent item delay a due reminder", async () => {
    const { store, clock, notifier, lanes, larry } = await setup()
    // An issue-label research item, claimed and due, with no runtime to run it.
    const { task: agentTask } = await createTask(
      store,
      actor(larry),
      larry,
      { type: research, title: "issue", config: {}, schedule: null },
      clock.now(),
    )
    await store.createOccurrence({
      taskId: agentTask.id,
      lane: "execute",
      dueAt: T0,
      dedupeKey: issueKey("o/r", 1, "research"),
      at: T0,
    })
    // A reminder due at 09:00 EST today.
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: reminder, title: "dentist", config: { text: "dentist" }, schedule: daily },
      clock.now(),
    )
    clock.set("2026-03-02T14:00:30.000Z")

    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(await lanes.tickNotify()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(notifier.sent.map((s) => [s.userId, s.message.text])).toEqual([[larry.id, "dentist"]])
    const [done, next] = await store.listOccurrences({ taskId: task.id })
    expect(done?.status).toBe("done")
    expect(done?.late).toBe(false)
    expect(next?.dueAt).toBe("2026-03-03T14:00:00.000Z") // tomorrow's, materialized on completion
    expect((await store.listOccurrences({ taskId: agentTask.id }))[0]?.status).toBe("queued")
  })

  it("does not resend after a crash between the send and the status flip", async () => {
    const { store, clock, notifier, lanes, larry, moe } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: reminder, title: "dentist", config: { text: "dentist" }, schedule: daily },
      clock.now(),
    )
    await invite(store, actor(larry), task, moe.id, clock.now())
    await respondToInvite(store, task, moe.id, "accept", clock.now())
    clock.set("2026-03-02T14:00:30.000Z")
    await lanes.tickNotify()
    expect(notifier.sent).toHaveLength(2)
    const [first] = await store.listOccurrences({ taskId: task.id })
    if (!first) throw new Error("no occurrence")

    // The crash: the process died after both DMs went out but before the status flip.
    await store.updateOccurrence(first.id, { status: "running", finishedAt: null })
    expect(await lanes.recover()).toEqual([first.id])
    await lanes.tickNotify()

    expect(notifier.sent).toHaveLength(2)
    expect((await store.getOccurrence(first.id))?.status).toBe("done")
  })

  it("marks a missed occurrence late and fires it once", async () => {
    const { store, clock, notifier, lanes, larry } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: reminder, title: "dentist", config: { text: "dentist" }, schedule: daily },
      clock.now(),
    )
    clock.set("2026-03-04T02:00:00.000Z") // the process was down for a day and a half
    expect(await lanes.tickNotify()).toMatchObject({ ran: 1 })
    const all = await store.listOccurrences({ taskId: task.id })
    expect(all[0]?.late).toBe(true)
    expect(all).toHaveLength(2)
    expect(all[1]?.dueAt).toBe("2026-03-04T14:00:00.000Z") // the next is from now, not from the missed one
    expect(notifier.sent).toHaveLength(1)
  })

  it("queues a new occurrence when a recipient snoozes", async () => {
    const { store, clock, lanes, larry } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      {
        type: reminder,
        title: "dentist",
        config: { text: "dentist" },
        schedule: { kind: "once", at: "2026-03-02T13:00:00.000Z" },
      },
      clock.now(),
    )
    await lanes.tickNotify()
    const [fired] = await store.listOccurrences({ taskId: task.id })
    const outcome = await lanes.reply({
      taskId: task.id,
      occurrenceId: fired?.id ?? null,
      userId: larry.id,
      kind: "snooze",
      payload: null,
    })
    expect(outcome?.snoozeUntil?.toISOString()).toBe("2026-03-02T13:00:00.000Z")
    const all = await store.listOccurrences({ taskId: task.id })
    expect(all.map((o) => o.status)).toEqual(["snoozed", "queued"])
    expect(all[1]?.dedupeKey).toBe(`manual:${task.id}:2`)
    expect((await store.listReplies(task.id)).map((r) => r.kind)).toEqual(["snooze"])
  })

  it("runs an execute-lane type through the executor and requeues when it is unavailable", async () => {
    const answer: JobResult = {
      kind: "success",
      result: "found it",
      totalCostUsd: 0.12,
      durationMs: 5,
    }
    let available = false
    const executor: Executor = {
      run: async (_spec: JobSpec) => {
        if (!available) throw new ExecutorUnavailableError("runner offline")
        return answer
      },
    }
    const { store, clock, notifier, lanes, larry } = await setup(executor)
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: research, title: "q", config: {}, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    clock.advance(1)
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect((await store.listOccurrences({ taskId: task.id }))[0]?.status).toBe("queued")

    available = true
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    const [occ] = await store.listOccurrences({ taskId: task.id })
    expect(occ?.status).toBe("done")
    expect(occ?.costUsd).toBe(0.12)
    expect(notifier.sent[0]?.message.text).toBe("found it")
  })

  it("fails an occurrence whose type is unknown, with the reason on record", async () => {
    const { store, clock, larry } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: reminder, title: "t", config: { text: "x" }, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    await store.updateTask(task.id, { at: T0, config: {} })
    const ghost = { ...types }
    const broken = new Lanes({
      store,
      clock,
      types: { other: ghost.research },
      notifier: new FakeNotifier(),
    })
    clock.advance(1)
    expect(await broken.tickNotify()).toEqual({ ran: 0, failed: 1, skipped: 0 })
    const [occ] = await store.listOccurrences({ taskId: task.id })
    expect(occ?.status).toBe("failed")
    expect(occ?.error).toBe("no task type reminder")
  })
})
