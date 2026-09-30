import { describe, expect, it } from "vitest"

import {
  createTask,
  type Executor,
  Lanes,
  MAX_RESUMES,
  type Occurrence,
  type OccurrencePatch,
  parseRunRecord,
  reschedule,
  type Schedule,
  STILL_FINISHING,
  type TaskType,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"
import { crossing, flaky, setup } from "./run-helpers.js"

const MIN = 60_000
const daily: Schedule = { kind: "calendar", every: 1, unit: "day", start: "2026-03-01" }

/** `store`, with `method` throwing once whenever `when` says so. */
function failing<K extends keyof MemoryStore>(
  store: MemoryStore,
  method: K,
  when: (...args: Parameters<Extract<MemoryStore[K], (...a: never[]) => unknown>>) => boolean,
  times = 1,
): { left: number } {
  const state = { left: times }
  const original = (store[method] as (...a: unknown[]) => unknown).bind(store)
  ;(store as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
    if (state.left > 0 && (when as (...a: unknown[]) => boolean)(...args)) {
      state.left--
      return Promise.reject(new Error(`store down (${String(method)})`))
    }
    return original(...args)
  }
  return state
}

describe("the abort signal", () => {
  it("runs nothing once aborted: the due run stays queued and unstarted", async () => {
    const { store, lanes, notifier, runs, runId } = await setup()
    const abort = new AbortController()
    abort.abort()
    expect(await lanes.tickNotify(abort.signal)).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(runs.n).toBe(0)
    expect(notifier.attempts).toHaveLength(0)
    const run = await store.getOccurrence(await runId())
    expect([run?.status, run?.startedAt]).toEqual(["queued", null])
  })

  it("drops an outcome the abort reached before it was stored, so the retry applies it once", async () => {
    const { store, clock, lanes, notifier, runs, task, value, runId } = await setup()
    const abort = new AbortController()
    const type = crossing(() => {
      abort.abort() // a page read cut short by a restart
      return value.v
    }, runs)
    const aborting = new Lanes({ store, clock, types: { crossing: type }, notifier })
    expect(await aborting.tickNotify(abort.signal)).toMatchObject({ ran: 0, skipped: 1 })
    expect(runs.n).toBe(1)
    expect((await store.getTask(task.id))?.state).toBeNull()
    expect(await store.listSeries(task.id)).toHaveLength(0)
    expect(notifier.attempts).toHaveLength(0)
    const run = await store.getOccurrence(await runId())
    expect([run?.status, run?.startedAt, run?.record]).toEqual(["queued", null, null])

    expect(await lanes.tickNotify()).toMatchObject({ ran: 1 })
    expect((await store.getTask(task.id))?.state).toEqual({ below: true })
    expect((await store.listSeries(task.id)).map((p) => p.value)).toEqual([5])
    expect(notifier.sent.map((s) => s.message.text)).toEqual(["dropped to 5"])
  })

  it("stops sending once aborted mid-delivery; the next tick sends the rest without a rerun", async () => {
    const { store, lanes, notifier, runs, runId, share, larry, moe, curly } = await setup()
    await share(moe, curly)
    const abort = new AbortController()
    const send = notifier.sendDm.bind(notifier)
    notifier.sendDm = async (userId, message) => {
      const sent = await send(userId, message)
      abort.abort() // the host's tick ran out after the first DM
      return sent
    }
    await lanes.tickNotify(abort.signal)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
    expect((await store.getOccurrence(await runId()))?.status).toBe("done")

    notifier.sendDm = send
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id, curly.id])
  })
})

describe("the order of a run", () => {
  it("retries a failed alert without running the type again or losing the alert", async () => {
    const { store, clock, lanes, notifier, runs, task, larry } = await setup()
    notifier.failFor.set(larry.id, flaky)
    await lanes.tickNotify()
    expect((await store.getTask(task.id))?.state).toEqual({ below: true })
    expect(notifier.sent).toHaveLength(0)
    notifier.failFor.clear()
    clock.advance(MIN)
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => [s.userId, s.message.text])).toEqual([
      [larry.id, "dropped to 5"],
    ])
    expect((await store.listSeries(task.id)).map((p) => p.value)).toEqual([5])
  })

  it("advances the schedule the moment a run fires, whatever it still owes", async () => {
    const { store, lanes, notifier, task, share, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, flaky)
    await lanes.tickNotify()
    const queued = await store.listOccurrences({ taskId: task.id, status: "queued" })
    expect(queued.map((o) => o.dueAt)).toEqual(["2026-03-02T12:15:00.000Z"])
  })

  it("sends a crashed-and-recovered run afresh when it had not fired", async () => {
    const { store, lanes, notifier, runs, runId } = await setup()
    const id = await runId()
    // The process died mid-run, before any outcome was recorded.
    await store.updateOccurrence(id, { status: "running", startedAt: T0 })
    expect(await lanes.recover()).toEqual([id])
    const back = await store.getOccurrence(id)
    expect([back?.status, back?.startedAt]).toEqual(["queued", null])
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent).toHaveLength(1)
  })

  it("resumes a fired run from its record after a crash, never running the type again", async () => {
    const { store, lanes, notifier, runs, task, runId } = await setup()
    // The Store fails right after the record is written: the run is fired, nothing applied.
    failing(store, "planDelivery", () => true)
    await lanes.tickNotify()
    const id = await runId()
    // ... and the process dies while resuming it.
    await store.updateOccurrence(id, { status: "running" })
    await lanes.recover()
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent).toHaveLength(1)
    expect((await store.listSeries(task.id)).length).toBe(1)
    expect((await store.getOccurrence(id))?.status).toBe("done")
  })

  it("never appends a series point twice when an outcome is applied again", async () => {
    const { store, lanes, runs, task, runId } = await setup()
    // The apply goes through, then marking it applied fails: the resume applies it again.
    failing(
      store,
      "updateOccurrence",
      (_id: string, patch: OccurrencePatch) => patch.record?.appliedAt != null,
    )
    await lanes.tickNotify()
    expect((await store.getOccurrence(await runId()))?.status).toBe("queued")
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect((await store.listSeries(task.id)).map((p) => p.key)).toEqual([`${await runId()}:0`])
  })

  it("puts a fired run back after a Store error at most three times, then ends it done", async () => {
    const { store, lanes, runs, runId } = await setup()
    failing(store, "planDelivery", () => true, 99)
    for (let i = 0; i <= MAX_RESUMES; i++) await lanes.tickNotify()
    const run = await store.getOccurrence(await runId())
    expect(run?.status).toBe("done")
    expect(run?.error).toMatch(/could not finish after 3 tries: store down/)
    expect(runs.n).toBe(1)
  })

  it("resumes a fired execute-lane run on the notify tick, with no executor", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const notifier = new FakeNotifier()
    const { larry } = await people(store)
    let calls = 0
    const research: TaskType<unknown> = {
      id: "research",
      lane: "execute",
      capabilities: ["notify"],
      schedule: ["once"],
      prepare: async () => ({ prompt: "look" }),
      finish: async () => ({ notify: { text: "found" } }),
    }
    const executor: Executor = {
      run: async () => {
        calls++
        return { kind: "success", result: "x", durationMs: 1 }
      },
    }
    await createTask(
      store,
      actor(larry),
      larry,
      { type: research, title: "q", config: {}, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    failing(store, "planDelivery", () => true)
    await new Lanes({ store, clock, types: { research }, notifier, executor }).tickExecute()
    expect(notifier.sent).toHaveLength(0)
    // The runner is gone, and the usage limit would not matter: the notify tick finishes it.
    const noRunner = new Lanes({ store, clock, types: { research }, notifier })
    expect(await noRunner.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 0 })
    await noRunner.tickNotify()
    expect(calls).toBe(1)
    expect(notifier.sent.map((s) => s.message.text)).toEqual(["found"])
  })

  it("ignores a record the dispatcher did not write, and delivers nothing from it", async () => {
    const { store, lanes, notifier, runs, runId } = await setup()
    const id = await runId()
    await store.updateOccurrence(id, {
      record: { outcome: { notify: { text: 1 } } } as unknown as Occurrence["record"],
    })
    await lanes.tickNotify()
    const run = await store.getOccurrence(id)
    expect([run?.status, run?.error]).toEqual(["done", "the run's record could not be read"])
    expect(runs.n).toBe(0)
    expect(notifier.attempts).toHaveLength(0)
  })

  it("never stores a snoozeUntil a run returned, so its record stays readable", async () => {
    const store = new MemoryStore()
    const { larry } = await people(store)
    const notifier = new FakeNotifier()
    const pushy: TaskType<unknown> = {
      id: "pushy",
      lane: "notify",
      capabilities: ["notify"],
      schedule: ["once"],
      run: async (ctx) => ({
        notify: { text: "hi" },
        snoozeUntil: new Date(ctx.now.getTime() + MIN),
      }),
    }
    const lanes = new Lanes({
      store,
      clock: new FakeClock(new Date(T0)),
      types: { pushy },
      notifier,
    })
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: pushy, title: "p", config: {}, schedule: { kind: "once", at: T0 } },
      new Date(T0),
    )
    await lanes.tickNotify()
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect(run?.record?.outcome).not.toHaveProperty("snoozeUntil")
    expect(parseRunRecord(run?.record)).not.toBeNull()
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
  })
})

describe("answers and edits while a run still owes a copy", () => {
  it("lets the owner snooze it: recipients still get the run, the snooze re-asks the owner", async () => {
    const { store, clock, lanes, notifier, task, runId, share, larry, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, flaky)
    await lanes.tickNotify()
    const id = await runId()
    await lanes.reply({
      taskId: task.id,
      occurrenceId: id,
      userId: larry.id,
      kind: "snooze",
      payload: null,
    })
    expect((await store.getOccurrence(id))?.status).toBe("snoozed")
    notifier.failFor.clear()
    clock.advance(MIN)
    await lanes.tickNotify()
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id])
    // The snooze's run: the owner alone. (The 12:15 poll finds no new crossing.)
    clock.set("2026-03-02T13:00:30.000Z")
    await lanes.tickNotify()
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id, larry.id])
  })

  it("refuses a snooze pressed while the run is finishing, and takes it once it is done", async () => {
    const { store, lanes, notifier, task, runId, share, larry, moe } = await setup()
    await share(moe)
    const snooze = (occurrenceId: string) =>
      lanes.reply({
        taskId: task.id,
        occurrenceId,
        userId: larry.id,
        kind: "snooze",
        payload: null,
      })
    let refusal = ""
    const plan = store.planDelivery.bind(store)
    store.planDelivery = async (occurrenceId, userId, at) => {
      if (userId === moe.id) await snooze(occurrenceId).catch((e: Error) => (refusal = e.message))
      return plan(occurrenceId, userId, at)
    }
    await lanes.tickNotify()
    expect(refusal).toBe(STILL_FINISHING)
    const id = await runId()
    expect((await store.getOccurrence(id))?.status).toBe("done")
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id])
    await snooze(id)
    expect((await store.getOccurrence(id))?.status).toBe("snoozed")
  })

  it("lets the owner finish the task: recipients still owed a copy get it", async () => {
    const once: Schedule = { kind: "once", at: T0 }
    const { store, clock, lanes, notifier, task, runId, share, larry, moe } = await setup({
      schedule: once,
    })
    await share(moe)
    notifier.failFor.set(moe.id, flaky)
    await lanes.tickNotify()
    const id = await runId()
    await lanes.reply({
      taskId: task.id,
      occurrenceId: id,
      userId: larry.id,
      kind: "done",
      payload: null,
    })
    expect((await store.getTask(task.id))?.status).toBe("done")
    notifier.failFor.clear()
    clock.advance(MIN)
    await lanes.tickNotify()
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id])
  })

  it("keeps a fired run put back to finish when the task completes, and finishes it", async () => {
    const { store, lanes, notifier, runs, task, type, runId, larry } = await setup({
      schedule: { kind: "once", at: T0 },
    })
    failing(store, "planDelivery", () => true)
    await lanes.tickNotify()
    const id = await runId()
    expect((await store.getOccurrence(id))?.status).toBe("queued")
    const answer = (kind: "done" | "text") =>
      lanes.reply({ taskId: task.id, occurrenceId: id, userId: larry.id, kind, payload: null })
    // The owner's done waits for the run to finish ...
    await expect(answer("done")).rejects.toThrow(STILL_FINISHING)
    // ... but the task can still complete meanwhile (here a type ending it on a text reply).
    type.onReply = async () => ({ complete: true })
    await answer("text")
    expect((await store.getTask(task.id))?.status).toBe("done")
    expect(await store.getOccurrence(id)).not.toBeNull()
    await lanes.tickNotify()
    expect((await store.getOccurrence(id))?.status).toBe("done")
    expect(runs.n).toBe(1)
    expect(notifier.sent).toHaveLength(1)
  })

  it("keeps a fired run when the schedule changes, and returns the real next run", async () => {
    const { store, clock, lanes, task, runId, larry } = await setup()
    failing(store, "planDelivery", () => true)
    await lanes.tickNotify()
    const current = await store.getTask(task.id)
    if (!current) throw new Error("no task")
    const hourly: Schedule = { kind: "poll", every: 1, unit: "hour", start: T0 }
    const result = await reschedule(store, current, larry, hourly, larry.id, clock.now())
    expect(result.removed).toBe(1) // the 12:15 poll, not the fired run
    expect(result.next?.dueAt).toBe("2026-03-02T13:00:00.000Z")
    expect((await store.getOccurrence(await runId()))?.record).not.toBeNull()
  })

  it("keeps a queued snooze's run when the schedule changes", async () => {
    const { store, clock, lanes, task, runId, larry } = await setup({ schedule: daily })
    clock.set("2026-03-02T14:00:30.000Z")
    await lanes.tickNotify()
    await lanes.reply({
      taskId: task.id,
      occurrenceId: await runId(),
      userId: larry.id,
      kind: "snooze",
      payload: null,
    })
    const current = await store.getTask(task.id)
    if (!current) throw new Error("no task")
    const result = await reschedule(
      store,
      current,
      larry,
      { ...daily, hour: 18 },
      larry.id,
      clock.now(),
    )
    expect(result.removed).toBe(1) // tomorrow's 09:00, not the snooze
    const queued = await store.listOccurrences({ taskId: task.id, status: "queued" })
    expect(queued.map((o) => [o.dedupeKey.split(":")[0], o.dueAt])).toEqual([
      ["snooze", "2026-03-02T15:00:30.000Z"],
      ["sched", "2026-03-02T23:00:00.000Z"],
    ])
  })
})

describe("paused tasks and the re-check", () => {
  it("never runs a due occurrence of a paused task, and runs it once resumed", async () => {
    const { store, clock, lanes, notifier, runs, task } = await setup()
    await store.updateTask(task.id, { status: "paused", at: T0 })
    clock.advance(MIN)
    expect(await lanes.tickNotify()).toEqual({ ran: 0, failed: 0, skipped: 0 })
    expect(runs.n).toBe(0)
    await store.updateTask(task.id, { status: "active", at: T0 })
    expect(await lanes.tickNotify()).toMatchObject({ ran: 1 })
    expect(notifier.sent).toHaveLength(1)
  })

  it("re-checks the task before a run: one paused by an earlier run this tick waits", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    let second = ""
    let ran = 0
    const pauser: TaskType<unknown> = {
      id: "pauser",
      lane: "notify",
      capabilities: ["notify"],
      schedule: ["once"],
      run: async (ctx) => {
        ran++
        if (ctx.task.id !== second) await store.updateTask(second, { status: "paused", at: T0 })
        return {}
      },
    }
    const make = async (title: string) =>
      (
        await createTask(
          store,
          actor(larry),
          larry,
          { type: pauser, title, config: {}, schedule: { kind: "once", at: T0 } },
          clock.now(),
        )
      ).task
    await make("first")
    second = (await make("second")).id
    const lanes = new Lanes({ store, clock, types: { pauser }, notifier: new FakeNotifier() })
    expect(await lanes.tickNotify()).toEqual({ ran: 1, failed: 0, skipped: 1 })
    expect(ran).toBe(1)
    expect((await store.listOccurrences({ taskId: second }))[0]?.status).toBe("queued")
  })

  it("never starts one run twice from two overlapping ticks", async () => {
    const { lanes, runs, notifier } = await setup()
    await Promise.all([lanes.tickNotify(), lanes.tickNotify()])
    expect(runs.n).toBe(1)
    expect(notifier.sent).toHaveLength(1)
  })

  it("holds what a paused task owes, with a fresh round of attempts, and sends it on resume", async () => {
    const { store, clock, lanes, notifier, runs, runId, task, share, larry, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, flaky)
    await lanes.tickNotify()
    clock.advance(MIN)
    await lanes.tickNotify() // a second failure
    await store.updateTask(task.id, { status: "paused", at: T0 }) // the host pauses the task
    const row = async () =>
      (await store.listDeliveries({ occurrenceId: await runId() })).find((d) => d.userId === moe.id)
    expect((await row())?.attempts).toBe(2)
    clock.advance(10 * MIN)
    await lanes.tickNotify()
    expect([(await row())?.attempts, (await row())?.status]).toEqual([0, "failed"])
    expect(notifier.attempts.filter((u) => u === moe.id)).toHaveLength(2)

    notifier.failFor.clear()
    await store.updateTask(task.id, { status: "active", at: T0 })
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id])
  })
})
