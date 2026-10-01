import { describe, expect, it } from "vitest"

import {
  createTask,
  DEFAULT_BUDGET,
  type Executor,
  ExecutorUnavailableError,
  GAVE_UP_EVENT,
  JobPendingError,
  type JobResult,
  Lanes,
  PENDING_LIMIT_MS,
  reschedule,
  ScheduleError,
  SLOW_JOB_MS,
  STALE_RUN_MS,
  type Store,
  type TaskType,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

/** Finishes with what it got; a poll schedule unless the test says once. */
const asker: TaskType<unknown> = {
  id: "asker",
  lane: "execute",
  capabilities: ["notify"],
  schedule: ["once", "poll"],
  prepare: async () => ({ prompt: "look" }),
  finish: async (_ctx, result) => ({
    notify: { text: result.kind === "success" ? result.result : `failed: ${result.detail}` },
    findings: result.kind === "success" ? [{ text: "found it" }] : [],
    summary: result.kind,
  }),
  onReply: async (ctx) => (ctx.reply.kind === "done" ? { complete: true } : {}),
}

const ok: JobResult = { kind: "success", result: "found", totalCostUsd: 0.05, durationMs: 1 }

/** city-hall in miniature: a Job per key, pending while `busy` is true, then `ok`. */
function cityHall() {
  const keys: string[] = []
  const state = { busy: true, throws: null as Error | null }
  const executor: Executor = {
    run: async (_spec, _occurrenceId, jobKey) => {
      keys.push(jobKey)
      if (state.throws) throw state.throws
      if (state.busy) throw new JobPendingError(`job ${jobKey} is running`)
      return ok
    },
  }
  return { executor, keys, state }
}

async function setup(
  executor: Executor,
  options: { budget?: typeof DEFAULT_BUDGET; store?: Store; once?: boolean } = {},
) {
  const store = options.store ?? new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const folks = await people(store as MemoryStore)
  const lanes = new Lanes({
    store,
    clock,
    types: { asker },
    notifier,
    executor,
    budget: options.budget ?? DEFAULT_BUDGET,
  })
  const ask = async (owner = folks.larry, at = T0) =>
    (
      await createTask(
        store,
        actor(owner),
        owner,
        {
          type: asker,
          title: "q",
          config: {},
          schedule: options.once
            ? { kind: "once", at }
            : { kind: "poll", every: 1, unit: "hour", start: at },
        },
        clock.now(),
      )
    ).task
  return { store, clock, notifier, lanes, ask, ...folks }
}

describe("a run whose Job is out", () => {
  it("survives reschedules: one key, one Job, one charge (the reviewers' repro)", async () => {
    const { executor, keys, state } = cityHall()
    const { store, clock, lanes, ask, larry } = await setup(executor, {
      budget: { ...DEFAULT_BUDGET, person: { usd: null, calls: 1 } },
    })
    const task = await ask()
    for (let round = 0; round < 3; round++) {
      await lanes.tickExecute()
      const current = await store.getTask(task.id)
      if (!current) throw new Error("no task")
      await reschedule(
        store,
        current,
        larry,
        { kind: "poll", every: 2, unit: "hour", start: clock.now().toISOString() },
        larry.id,
        clock.now(),
      )
      clock.advance(60_000)
    }
    expect(new Set(keys).size).toBe(1)
    state.busy = false
    await lanes.tickExecute()
    expect(await store.listUsage()).toHaveLength(1)
  })

  it("is not deleted when its task completes, and is collected and charged; the outcome is dropped", async () => {
    const { executor, keys, state } = cityHall()
    const { store, clock, notifier, lanes, ask, larry } = await setup(executor)
    const task = await ask()
    state.busy = false
    await lanes.tickExecute()
    const [first] = await store.listOccurrences({ taskId: task.id, status: "done" })
    // The next run's Job goes out, then the owner ends the task on the first run.
    state.busy = true
    clock.advance(3_600_000)
    await lanes.tickExecute()
    await lanes.reply({
      taskId: task.id,
      occurrenceId: first?.id ?? null,
      userId: larry.id,
      kind: "done",
      payload: null,
    })
    expect((await store.getTask(task.id))?.status).toBe("done")
    expect(await store.listOccurrences({ taskId: task.id, status: "queued" })).toHaveLength(1)
    const sent = notifier.sent.length
    state.busy = false
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(new Set(keys).size).toBe(2)
    expect(await store.listUsage()).toHaveLength(2)
    // Dropped: no DM, no finding from the late collection.
    expect(notifier.sent.length).toBe(sent)
    expect(await store.listFindings({ taskId: task.id })).toHaveLength(1)
    const runs = await store.listOccurrences({ taskId: task.id })
    expect(runs[1]?.summary).toBe("collected after the task was done; outcome dropped")
  })

  it("is collected when its task was archived, charged, its outcome dropped", async () => {
    const { executor, state } = cityHall()
    const { store, notifier, lanes, ask } = await setup(executor, { once: true })
    const task = await ask()
    await lanes.tickExecute()
    await store.updateTask(task.id, { status: "archived", at: T0 })
    state.busy = false
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(await store.listUsage()).toHaveLength(1)
    expect(notifier.sent).toEqual([])
    expect(await store.listFindings()).toEqual([])
  })

  it("is collected when its task was paused: applied, its sends held until resume", async () => {
    const { executor, state } = cityHall()
    const { store, notifier, lanes, ask } = await setup(executor, { once: true })
    const task = await ask()
    await lanes.tickExecute()
    await store.updateTask(task.id, { status: "paused", at: T0 })
    state.busy = false
    await lanes.tickExecute()
    expect(await store.listUsage()).toHaveLength(1)
    expect(await store.listFindings({ taskId: task.id })).toHaveLength(1)
    await lanes.tickNotify()
    expect(notifier.sent).toEqual([])
    await store.updateTask(task.id, { status: "active", at: T0 })
    await lanes.tickNotify()
    expect(notifier.sent.map((s) => s.message.text)).toEqual(["found"])
  })

  it("is asked about before any new run starts, even one due earlier", async () => {
    const { executor, keys, state } = cityHall()
    const { store, lanes, ask, moe } = await setup(executor, { once: true })
    const first = await ask()
    await lanes.tickExecute()
    // Moe's run is due an hour before Larry's, so it sorts first by due time.
    const earlier = await ask(moe, "2026-03-02T11:00:00.000Z")
    await lanes.tickExecute()
    await lanes.tickExecute()
    const [larrys] = await store.listOccurrences({ taskId: first.id })
    expect(keys.every((k) => k === larrys?.id)).toBe(true)
    state.busy = false
    expect(await lanes.tickExecute()).toEqual({ ran: 2, failed: 0, skipped: 0 })
    expect((await store.listOccurrences({ taskId: earlier.id }))[0]?.status).toBe("done")
  })

  it(`is given up after ${PENDING_LIMIT_MS / 3_600_000} hours: finish hears why, one charge, the lane moves on`, async () => {
    const { executor, keys } = cityHall()
    const { store, clock, notifier, lanes, ask, larry, moe } = await setup(executor, { once: true })
    const task = await ask()
    await lanes.tickExecute()
    const other = await ask(moe)
    clock.advance(PENDING_LIMIT_MS - 60_000)
    await lanes.tickExecute()
    expect(keys).toHaveLength(2)
    clock.advance(60_000)
    const result = await lanes.tickExecute()
    // Larry's Job was asked about once more, answered pending, and given up; Moe's then went out.
    expect(result).toEqual({ ran: 1, failed: 0, skipped: 1 })
    expect(keys).toHaveLength(4)
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect(keys.slice(0, 3)).toEqual([run?.id, run?.id, run?.id])
    expect(keys[3]).not.toBe(run?.id)
    expect(notifier.sent.filter((s) => s.userId === larry.id).map((s) => s.message.text)).toEqual([
      "failed: the job did not finish in time",
    ])
    const errors = (await store.listEvents(run?.id ?? "")).filter((e) => e.type === "error")
    expect(errors.map((e) => e.text)).toEqual([
      expect.stringContaining("out at the runner for over 1 h"),
      `${GAVE_UP_EVENT} after 6 h`,
    ])
    expect((await store.listUsage()).map((u) => u.key)).toEqual([run?.id])
    expect((await store.listOccurrences({ taskId: other.id }))[0]?.status).toBe("queued")
  })

  it("is charged once when a crash came between its charge and its record", async () => {
    const inner = new MemoryStore()
    let failRecord = true
    const store: Store = Object.assign(Object.create(inner), {
      updateOccurrence: async (id: string, patch: Parameters<Store["updateOccurrence"]>[1]) => {
        if (patch.record && failRecord) {
          failRecord = false
          throw new Error("crash before the record")
        }
        return inner.updateOccurrence(id, patch)
      },
    })
    const { executor, state } = cityHall()
    state.busy = false
    const { lanes, ask } = await setup(executor, { store, once: true })
    await ask()
    await lanes.tickExecute()
    // The run failed writing its record; the next run of it asks the same key again.
    const [run] = await inner.listOccurrences()
    await inner.updateOccurrence(run?.id ?? "", { status: "queued", error: null })
    await lanes.tickExecute()
    expect((await inner.listUsage()).map((u) => u.key)).toEqual([run?.id])
  })

  it("is put back by the sweep when a Store error left it running while it waited", async () => {
    const inner = new MemoryStore()
    let fail = true
    const store: Store = Object.assign(Object.create(inner), {
      updateOccurrenceIf: async (
        id: string,
        expected: Parameters<Store["updateOccurrenceIf"]>[1],
        patch: Parameters<Store["updateOccurrenceIf"]>[2],
      ) => {
        if (fail && expected === "running" && patch.status === "queued") {
          fail = false
          throw new Error("database is locked")
        }
        return inner.updateOccurrenceIf(id, expected, patch)
      },
    })
    const { executor, state } = cityHall()
    const { clock, lanes, ask } = await setup(executor, { store, once: true })
    const task = await ask()
    await lanes.tickExecute()
    expect((await inner.listOccurrences({ taskId: task.id }))[0]?.status).toBe("running")
    state.busy = false
    await lanes.tickExecute()
    expect((await inner.listOccurrences({ taskId: task.id }))[0]?.status).toBe("running")
    clock.advance(STALE_RUN_MS + 1)
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect((await inner.listOccurrences({ taskId: task.id }))[0]?.status).toBe("done")
    expect(await inner.listUsage()).toHaveLength(1)
  })
})

describe("an execute-lane type always gets to finish", () => {
  it("when the Executor throws: an uncharged error result, so the owner is told", async () => {
    const { executor, state } = cityHall()
    state.throws = new Error("socket hang up")
    const { store, notifier, lanes, ask } = await setup(executor, { once: true })
    const task = await ask()
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(notifier.sent.map((s) => s.message.text)).toEqual([
      "failed: the executor failed: socket hang up",
    ])
    expect(await store.listUsage()).toEqual([])
    expect((await store.listOccurrences({ taskId: task.id }))[0]?.summary).toBe("error")
  })

  it("when prepare throws: an uncharged error result, and no Job", async () => {
    const broken: TaskType<unknown> = {
      ...asker,
      id: "asker",
      prepare: async () => {
        throw new Error("a research request needs a question")
      },
    }
    const { executor, keys } = cityHall()
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const notifier = new FakeNotifier()
    const { larry } = await people(store)
    const lanes = new Lanes({ store, clock, types: { asker: broken }, notifier, executor })
    await createTask(
      store,
      actor(larry),
      larry,
      { type: broken, title: "q", config: {}, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    await lanes.tickExecute()
    expect(keys).toEqual([])
    expect(notifier.sent.map((s) => s.message.text)).toEqual([
      "failed: prepare failed: a research request needs a question",
    ])
    expect(await store.listUsage()).toEqual([])
  })

  it("when prepare needs no Job: its outcome, no call, no charge", async () => {
    const skipping: TaskType<unknown> = {
      ...asker,
      prepare: async () => ({ outcome: { notify: { text: "nothing to do" }, complete: true } }),
    }
    const { executor, keys } = cityHall()
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const notifier = new FakeNotifier()
    const { larry } = await people(store)
    const lanes = new Lanes({ store, clock, types: { asker: skipping }, notifier, executor })
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: skipping, title: "q", config: {}, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    await lanes.tickExecute()
    expect(keys).toEqual([])
    expect(notifier.sent.map((s) => s.message.text)).toEqual(["nothing to do"])
    expect(await store.listUsage()).toEqual([])
    expect((await store.getTask(task.id))?.status).toBe("done")
  })
})

describe("a Job that is out, asked about again", () => {
  it("is collected without running prepare again, even if prepare would now skip or throw", async () => {
    for (const later of ["skip", "throw"] as const) {
      let prepares = 0
      const fickle: TaskType<unknown> = {
        ...asker,
        prepare: async () => {
          prepares++
          if (prepares === 1) return { prompt: "look" }
          if (later === "skip") return { outcome: { summary: "deadline missed", complete: true } }
          throw new Error("config edited")
        },
      }
      const { executor, keys, state } = cityHall()
      const store = new MemoryStore()
      const clock = new FakeClock(new Date(T0))
      const notifier = new FakeNotifier()
      const { larry } = await people(store)
      const lanes = new Lanes({ store, clock, types: { asker: fickle }, notifier, executor })
      const { task } = await createTask(
        store,
        actor(larry),
        larry,
        { type: fickle, title: "q", config: {}, schedule: { kind: "once", at: T0 } },
        clock.now(),
      )
      await lanes.tickExecute()
      state.busy = false
      await lanes.tickExecute()
      expect(prepares).toBe(1)
      const [run] = await store.listOccurrences({ taskId: task.id })
      expect(keys).toEqual([run?.id, run?.id])
      expect(run?.summary).toBe("success")
      expect(await store.listUsage()).toHaveLength(1)
      expect(notifier.sent.map((m) => m.message.text)).toEqual(["found"])
    }
  })

  it("is asked with no spec: the Executor answers the Job it has", async () => {
    const specs: unknown[] = []
    let n = 0
    const executor: Executor = {
      run: async (spec) => {
        specs.push(spec)
        if (++n === 1) throw new JobPendingError("running")
        return ok
      },
    }
    const { lanes, ask } = await setup(executor, { once: true })
    await ask()
    await lanes.tickExecute()
    await lanes.tickExecute()
    expect(specs).toEqual([{ prompt: "look" }, null])
  })

  it("waits out any other error under the same key, and is collected once", async () => {
    const { executor, keys, state } = cityHall()
    const { store, lanes, ask } = await setup(executor, { once: true })
    const task = await ask()
    await lanes.tickExecute()
    state.throws = new Error("HTTP 500")
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect(run?.status).toBe("queued")
    state.throws = null
    state.busy = false
    await lanes.tickExecute()
    expect(new Set(keys)).toEqual(new Set([run?.id]))
    expect((await store.listOccurrences({ taskId: task.id }))[0]?.summary).toBe("success")
    expect(await store.listUsage()).toHaveLength(1)
  })

  it("is never given up while city-hall is unreachable: it is collected when it is back", async () => {
    const { executor, state } = cityHall()
    const { store, clock, lanes, ask } = await setup(executor, { once: true })
    const task = await ask()
    await lanes.tickExecute()
    state.throws = new ExecutorUnavailableError("city-hall unreachable")
    for (let h = 0; h < 7; h++) {
      clock.advance(3_600_000)
      await lanes.tickExecute()
    }
    state.throws = null
    state.busy = false
    await lanes.tickExecute()
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect(run?.summary).toBe("success")
  })

  it(`tells the admins once when it has been out ${SLOW_JOB_MS / 3_600_000} h`, async () => {
    const { executor } = cityHall()
    const { store, clock, notifier, lanes, ask, admin } = await setup(executor, { once: true })
    const task = await ask()
    await lanes.tickExecute()
    clock.advance(SLOW_JOB_MS - 60_000)
    await lanes.tickExecute()
    expect(notifier.sent).toEqual([])
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000)
      await lanes.tickExecute()
    }
    const told = notifier.sent.filter((m) => m.userId === admin.id)
    expect(told).toHaveLength(1)
    expect(told[0]?.message.text).toContain("runs nothing else until it is back")
    const [run] = await store.listOccurrences({ taskId: task.id })
    const errors = (await store.listEvents(run?.id ?? "")).filter((e) => e.type === "error")
    expect(errors).toHaveLength(1)
  })

  it("keeps its key when an unavailable message merely mentions a usage limit", async () => {
    const { executor, keys, state } = cityHall()
    const { store, lanes, ask } = await setup(executor, { once: true })
    const task = await ask()
    await lanes.tickExecute()
    state.throws = new ExecutorUnavailableError("usage limit of the proxy reached")
    await lanes.tickExecute()
    state.throws = null
    state.busy = false
    await lanes.tickExecute()
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect(new Set(keys)).toEqual(new Set([run?.id]))
  })

  it("of a paused task, with an outcome that completes it, waits for the resume to complete and send", async () => {
    const completing: TaskType<unknown> = {
      ...asker,
      finish: async () => ({ notify: { text: "answer" }, complete: true }),
    }
    const { executor, state } = cityHall()
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const notifier = new FakeNotifier()
    const { larry } = await people(store)
    const lanes = new Lanes({ store, clock, types: { asker: completing }, notifier, executor })
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: completing, title: "q", config: {}, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    await lanes.tickExecute()
    await store.updateTask(task.id, { status: "paused", at: T0 })
    state.busy = false
    await lanes.tickExecute()
    await lanes.tickNotify()
    await lanes.tickNotify()
    expect((await store.getTask(task.id))?.status).toBe("paused")
    expect(notifier.sent).toEqual([])
    expect(await store.listUsage()).toHaveLength(1)
    await store.updateTask(task.id, { status: "active", at: T0 })
    await lanes.tickNotify()
    expect((await store.getTask(task.id))?.status).toBe("done")
    expect(notifier.sent.map((m) => m.message.text)).toEqual(["answer"])
  })

  it("of a once task blocks a schedule edit; a recurring task's edit says the Job is out", async () => {
    const { executor } = cityHall()
    const once = await setup(executor, { once: true })
    const t1 = await once.ask()
    await once.lanes.tickExecute()
    await expect(
      reschedule(
        once.store,
        t1,
        once.larry,
        { kind: "once", at: "2026-03-05T12:00:00.000Z" },
        once.larry.id,
        once.clock.now(),
      ),
    ).rejects.toThrow(ScheduleError)
    expect(await once.store.listOccurrences({ taskId: t1.id })).toHaveLength(1)

    const polled = await setup(cityHall().executor)
    const t2 = await polled.ask()
    await polled.lanes.tickExecute()
    const result = await reschedule(
      polled.store,
      t2,
      polled.larry,
      { kind: "poll", every: 2, unit: "hour", start: T0 },
      polled.larry.id,
      polled.clock.now(),
    )
    expect([result.jobOut, result.removed, result.next]).toEqual([true, 0, null])
  })
})
