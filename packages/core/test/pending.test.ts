import { describe, expect, it } from "vitest"

import {
  charge,
  createTask,
  DEFAULT_BUDGET,
  type Executor,
  ExecutorUnavailableError,
  JobPendingError,
  type JobResult,
  Lanes,
  SUBMITTED_EVENT,
  type TaskType,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

const asker: TaskType<unknown> = {
  id: "asker",
  lane: "execute",
  capabilities: ["notify"],
  schedule: ["once"],
  prepare: async () => ({ prompt: "look" }),
  finish: async (_ctx, result) => ({
    notify: { text: result.kind === "success" ? result.result : `failed: ${result.kind}` },
    summary: result.kind,
    complete: true,
  }),
}

const ok: JobResult = { kind: "success", result: "found", totalCostUsd: 0.05, durationMs: 1 }

type Answer = JobResult | "pending" | "unavailable"

/**
 * city-hall's execute lane in miniature: a Job per key, answered from a script the first time the
 * key is seen and after each "pending"; a key already answered keeps its answer.
 */
function cityHall(...script: Answer[]) {
  const calls: { occurrenceId: string; jobKey: string }[] = []
  const answered = new Map<string, JobResult>()
  const executor: Executor = {
    run: async (_spec, occurrenceId, jobKey) => {
      calls.push({ occurrenceId, jobKey })
      const known = answered.get(jobKey)
      if (known) return known
      const next = script.shift() ?? ok
      if (next === "pending") throw new JobPendingError(`job ${jobKey} is running`)
      if (next === "unavailable") throw new ExecutorUnavailableError("city-hall unreachable")
      answered.set(jobKey, next)
      return next
    },
  }
  return { executor, calls }
}

async function setup(executor: Executor, budget = DEFAULT_BUDGET) {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const folks = await people(store)
  const lanes = new Lanes({ store, clock, types: { asker }, notifier, executor, budget })
  const ask = async (owner = folks.larry, title = "q") =>
    (
      await createTask(
        store,
        actor(owner),
        owner,
        { type: asker, title, config: {}, schedule: { kind: "once", at: T0 } },
        clock.now(),
      )
    ).task
  return { store, clock, notifier, lanes, ask, ...folks }
}

describe("a Job the runner has not finished", () => {
  it("is asked about again each tick under one key, charged once, and recorded once", async () => {
    const { executor, calls } = cityHall("pending", "pending", ok)
    const { store, clock, notifier, lanes, ask, larry } = await setup(executor)
    const task = await ask()
    const [run] = await store.listOccurrences({ taskId: task.id })
    for (const _ of [1, 2]) {
      expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 1 })
      const now = await store.getOccurrence(run?.id ?? "")
      expect([now?.status, now?.startedAt, now?.record]).toEqual(["queued", null, null])
      clock.advance(60_000)
    }
    expect(await store.listUsage()).toEqual([])
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(calls.map((c) => c.jobKey)).toEqual([run?.id, run?.id, run?.id])
    expect((await store.listUsage()).map((u) => [u.userId, u.calls])).toEqual([[larry.id, 1]])
    expect(notifier.sent.map((s) => s.message.text)).toEqual(["found"])
    const events = (await store.listEvents(run?.id ?? "")).map((e) => e.text)
    expect(events.filter((t) => t === SUBMITTED_EVENT)).toHaveLength(1)
    expect(events.filter((t) => t.startsWith("started"))).toHaveLength(1)
    // Not late: it started on time, however long the runner then took.
    expect((await store.getOccurrence(run?.id ?? ""))?.late).toBe(false)
  })

  it("holds the lane, so Jobs go to the runner one at a time", async () => {
    const { executor, calls } = cityHall("pending", ok, ok)
    const { lanes, ask, moe } = await setup(executor)
    await ask()
    await ask(moe)
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 2 })
    expect(calls).toHaveLength(1)
    expect(await lanes.tickExecute()).toEqual({ ran: 2, failed: 0, skipped: 0 })
  })

  it("is collected even if its owner reached a ceiling meanwhile, and after a restart", async () => {
    const { executor, calls } = cityHall("pending", ok, ok)
    const budget = { ...DEFAULT_BUDGET, person: { usd: null, calls: 1 } }
    const { store, clock, notifier, lanes, ask, larry } = await setup(executor, budget)
    const first = await ask()
    await lanes.tickExecute()
    // Meanwhile something else charged Larry to his ceiling.
    await charge(store, {
      userId: larry.id,
      taskId: null,
      source: "run",
      calls: 1,
      at: clock.now(),
    })
    const second = await ask(larry, "next")
    // A restart: a new Lanes on the same store still knows the Job is out.
    const restarted = new Lanes({ store, clock, types: { asker }, notifier, executor, budget })
    await restarted.recover()
    expect(await restarted.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 1 })
    expect((await store.listOccurrences({ taskId: first.id }))[0]?.status).toBe("done")
    // The next run of his is held: its Job was never submitted.
    expect((await store.listOccurrences({ taskId: second.id }))[0]?.status).toBe("queued")
    expect(calls).toHaveLength(2)
  })

  it("survives the runtime going away mid-wait: same key, no second submission event", async () => {
    const { executor, calls } = cityHall("pending", "unavailable", ok)
    const { store, lanes, ask } = await setup(executor)
    const task = await ask()
    await lanes.tickExecute()
    await lanes.tickExecute()
    await lanes.tickExecute()
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect(run?.status).toBe("done")
    expect(new Set(calls.map((c) => c.jobKey))).toEqual(new Set([run?.id]))
    const texts = (await store.listEvents(run?.id ?? "")).map((e) => e.text)
    expect(texts.filter((t) => t === SUBMITTED_EVENT)).toHaveLength(1)
    expect(await store.listUsage()).toHaveLength(1)
  })

  it("gets a fresh key after a usage limit, whose answer would otherwise come back for good", async () => {
    const limit: JobResult = {
      kind: "usage_limit",
      detail: "You've hit your session limit",
      resetsAt: "2026-03-02T15:00:00.000Z",
      durationMs: 1,
    }
    const { executor, calls } = cityHall("pending", limit, "pending", ok)
    const { store, clock, lanes, ask } = await setup(executor)
    const task = await ask()
    const [run] = await store.listOccurrences({ taskId: task.id })
    await lanes.tickExecute()
    await lanes.tickExecute()
    clock.set("2026-03-02T15:00:00.000Z")
    await lanes.tickExecute()
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(calls.map((c) => c.jobKey)).toEqual([run?.id, run?.id, `${run?.id}:1`, `${run?.id}:1`])
    expect(calls.every((c) => c.occurrenceId === run?.id)).toBe(true)
    expect((await store.getOccurrence(run?.id ?? ""))?.summary).toBe("success")
    expect(await store.listUsage()).toHaveLength(1)
  })

  it("after a usage limit, is budget-checked again before its fresh Job goes out", async () => {
    const limit: JobResult = { kind: "usage_limit", detail: "limit", durationMs: 1 }
    const { executor, calls } = cityHall("pending", limit)
    const budget = { ...DEFAULT_BUDGET, person: { usd: null, calls: 1 } }
    const { store, clock, lanes, ask, larry } = await setup(executor, budget)
    await ask()
    await lanes.tickExecute()
    await lanes.tickExecute()
    await charge(store, {
      userId: larry.id,
      taskId: null,
      source: "run",
      calls: 1,
      at: clock.now(),
    })
    clock.advance(3_600_000)
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(calls).toHaveLength(2)
  })
})
