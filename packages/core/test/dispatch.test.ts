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
import { actor, FakeClock, FakeFetch, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

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

/** Counts its runs in state, records each as a series point, ends itself on the third. */
const counter: TaskType<{ stopAt: number }> = {
  id: "counter",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["poll"],
  run: async (ctx) => {
    const n = ((ctx.state as { n?: number } | null)?.n ?? 0) + 1
    return {
      state: { n },
      series: [{ value: n, note: "run" }],
      complete: n >= ctx.config.stopAt,
      summary: `run ${n}`,
    }
  },
  onReply: async (ctx) => (ctx.reply.kind === "done" ? { complete: true } : {}),
}

/** Reads a page through the Fetch port and reports its body. */
const reader: TaskType<{ url: string }> = {
  id: "reader",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["poll"],
  run: async (ctx) => {
    if (!ctx.ports.fetch) throw new Error("no fetch port")
    const page = await ctx.ports.fetch.get(ctx.config.url)
    return { summary: `${page.status} ${page.body}` }
  },
}

const flaky: TaskType<unknown> = {
  id: "flaky",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["calendar"],
  run: async () => {
    throw new Error("site down")
  },
}

const types = {
  reminder: reminder as TaskType<unknown>,
  research,
  counter: counter as TaskType<unknown>,
  reader: reader as TaskType<unknown>,
  flaky,
}
const daily: Schedule = { kind: "calendar", every: 1, unit: "day", start: "2026-03-01" }
const quarterHourly: Schedule = { kind: "poll", every: 15, unit: "minute", start: T0 }

async function setup(executor?: Executor | null, fetch?: FakeFetch) {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const folks = await people(store)
  const lanes = new Lanes({
    store,
    clock,
    types,
    notifier,
    executor: executor ?? null,
    fetch: fetch ?? null,
  })
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

  it("queues a new occurrence when the owner snoozes", async () => {
    const { store, clock, lanes, larry } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      {
        type: reminder,
        title: "dentist",
        config: { text: "dentist" },
        schedule: { kind: "once", at: "2026-03-02T12:00:00.000Z" },
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
    expect(all[1]?.dedupeKey).toBe(`snooze:${all[0]?.id}`)
    expect((await store.listReplies(task.id)).map((r) => r.kind)).toEqual(["snooze"])
  })

  it("refuses to snooze a run that has not fired, which would end a recurring task", async () => {
    const { store, lanes, clock, larry } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: reminder, title: "dentist", config: { text: "dentist" }, schedule: daily },
      clock.now(),
    )
    const [queued] = await store.listOccurrences({ taskId: task.id })
    const snooze = { taskId: task.id, userId: larry.id, kind: "snooze" as const, payload: null }
    await expect(lanes.reply({ ...snooze, occurrenceId: queued?.id ?? null })).rejects.toThrow(
      "That run has not fired yet.",
    )
    expect((await store.listOccurrences({ taskId: task.id })).map((o) => o.status)).toEqual([
      "queued",
    ])
  })

  it("queues one run for two snoozes that both got past the checks", async () => {
    const { store, clock, lanes, larry } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      {
        type: reminder,
        title: "dentist",
        config: { text: "dentist" },
        schedule: { kind: "once", at: "2026-03-02T12:00:00.000Z" },
      },
      clock.now(),
    )
    await lanes.tickNotify()
    const [fired] = await store.listOccurrences({ taskId: task.id })
    const snooze = {
      taskId: task.id,
      occurrenceId: fired?.id ?? null,
      userId: larry.id,
      kind: "snooze" as const,
      payload: null,
    }
    await Promise.allSettled([lanes.reply(snooze), lanes.reply(snooze)])
    expect((await store.listOccurrences({ taskId: task.id, status: "queued" })).length).toBe(1)
  })

  it("keeps a snooze pressed while the run's messages are still going out", async () => {
    const { store, clock, lanes, notifier, larry, moe } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      {
        type: reminder,
        title: "dentist",
        config: { text: "dentist" },
        schedule: { kind: "once", at: "2026-03-02T12:00:00.000Z" },
      },
      clock.now(),
    )
    await invite(store, actor(larry), task, moe.id, clock.now())
    await respondToInvite(store, task, moe.id, "accept", clock.now())
    const send = notifier.sendDm.bind(notifier)
    notifier.sendDm = async (userId, message) => {
      if (userId === moe.id) {
        const occurrenceId = message.ref?.occurrenceId ?? null
        await lanes.reply({
          taskId: task.id,
          occurrenceId,
          userId: larry.id,
          kind: "snooze",
          payload: null,
        })
      }
      return send(userId, message)
    }
    await lanes.tickNotify()
    expect((await store.listOccurrences({ taskId: task.id })).map((o) => o.status)).toEqual([
      "snoozed",
      "queued",
    ])
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

  it("stores a type's state, appends its series, and ends the task when it says so", async () => {
    const { store, clock, lanes, larry } = await setup()
    const { task, next } = await createTask(
      store,
      actor(larry),
      larry,
      { type: counter, title: "count", config: { stopAt: 3 }, schedule: quarterHourly },
      clock.now(),
    )
    expect(next?.dueAt).toBe(T0) // a poll's first occurrence is its start: observe at once
    expect(await lanes.tickNotify()).toMatchObject({ ran: 1 })
    expect((await store.getTask(task.id))?.state).toEqual({ n: 1 })
    let all = await store.listOccurrences({ taskId: task.id })
    expect(all.map((o) => [o.status, o.dueAt])).toEqual([
      ["done", T0],
      ["queued", "2026-03-02T12:15:00.000Z"],
    ])

    clock.set("2026-03-02T12:15:00.000Z")
    await lanes.tickNotify()
    clock.set("2026-03-02T12:30:00.000Z")
    await lanes.tickNotify()

    const finished = await store.getTask(task.id)
    expect(finished?.status).toBe("done")
    expect(finished?.state).toEqual({ n: 3 })
    all = await store.listOccurrences({ taskId: task.id })
    expect(all.map((o) => o.status)).toEqual(["done", "done", "done"]) // nothing queued
    expect((await store.listSeries(task.id)).map((p) => p.value)).toEqual([1, 2, 3])
    expect((await store.listTaskEvents(task.id)).map((h) => h.kind)).toEqual([
      "created",
      "completed",
    ])
    clock.set("2026-03-02T12:45:00.000Z")
    expect(await lanes.tickNotify()).toEqual({ ran: 0, failed: 0, skipped: 0 })
  })

  it("ends a task from a reply that says so, dropping what was queued", async () => {
    const { store, clock, lanes, larry } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: counter, title: "count", config: { stopAt: 99 }, schedule: quarterHourly },
      clock.now(),
    )
    await lanes.tickNotify()
    const [first] = await store.listOccurrences({ taskId: task.id })
    const outcome = await lanes.reply({
      taskId: task.id,
      occurrenceId: first?.id ?? null,
      userId: larry.id,
      kind: "done",
      payload: null,
    })
    expect(outcome?.complete).toBe(true)
    expect((await store.getTask(task.id))?.status).toBe("done")
    expect((await store.listOccurrences({ taskId: task.id })).map((o) => o.status)).toEqual([
      "done",
    ])
    const completed = (await store.listTaskEvents(task.id)).find((h) => h.kind === "completed")
    expect(completed?.actorId).toBe(larry.id)
  })

  it("keeps a recurring task alive through a failed run", async () => {
    const { store, clock, lanes, larry } = await setup()
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: flaky, title: "flaky", config: {}, schedule: daily },
      clock.now(),
    )
    clock.set("2026-03-02T14:00:01.000Z")
    expect(await lanes.tickNotify()).toEqual({ ran: 0, failed: 1, skipped: 0 })
    const all = await store.listOccurrences({ taskId: task.id })
    expect(all.map((o) => [o.status, o.dueAt])).toEqual([
      ["failed", "2026-03-02T14:00:00.000Z"],
      ["queued", "2026-03-03T14:00:00.000Z"],
    ])
    expect(all[0]?.error).toBe("site down")
  })

  it("hands the host's Fetch port to a type that reads pages", async () => {
    const fetch = new FakeFetch({ "https://shop.example/widget": "<p>49.99</p>" })
    const { store, clock, lanes, larry } = await setup(null, fetch)
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      {
        type: reader,
        title: "widget",
        config: { url: "https://shop.example/widget" },
        schedule: quarterHourly,
      },
      clock.now(),
    )
    await lanes.tickNotify()
    expect(fetch.requests).toEqual(["https://shop.example/widget"])
    expect((await store.listOccurrences({ taskId: task.id }))[0]?.summary).toBe("200 <p>49.99</p>")
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
