import { describe, expect, it } from "vitest"

import {
  createTask,
  type Executor,
  Lanes,
  STALE_RUN_MS,
  STILL_FINISHING,
  type TaskType,
  visibleHistory,
  visibleReplies,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"
import { setup } from "./run-helpers.js"

const MIN = 60_000

/** Makes the Store's `method` reject while `when` says so, `times` times. */
function failing(
  store: object,
  method: string,
  when: (...args: never[]) => boolean,
  times = 1,
): { left: number } {
  const state = { left: times }
  const target = store as Record<string, (...a: unknown[]) => Promise<unknown>>
  const original = target[method]?.bind(store)
  if (!original) throw new Error(`no ${method}`)
  target[method] = (...args: unknown[]) => {
    if (state.left > 0 && (when as (...a: unknown[]) => boolean)(...args)) {
      state.left--
      return Promise.reject(new Error(`store down (${method})`))
    }
    return original(...args)
  }
  return state
}

/** The record's applied mark failing once: the run fires and is put back before it applies. */
const applyMark = (_id: string, patch: { record?: { appliedAt?: string | null } | null }) =>
  Boolean(patch.record?.appliedAt)

describe("a fired run that has not finished", () => {
  it("cannot be snoozed; the next tick finishes it and every copy goes out", async () => {
    const { store, clock, lanes, notifier, task, runId, share, larry, moe } = await setup()
    await share(moe)
    failing(store, "updateOccurrence", applyMark)
    await lanes.tickNotify()
    const id = await runId()
    expect((await store.getOccurrence(id))?.status).toBe("queued")
    const snooze = () =>
      lanes.reply({
        taskId: task.id,
        occurrenceId: id,
        userId: larry.id,
        kind: "snooze",
        payload: null,
      })
    await expect(snooze()).rejects.toThrow(STILL_FINISHING)
    clock.advance(30_000)
    await lanes.tickNotify()
    const run = await store.getOccurrence(id)
    expect([run?.status, run?.record?.appliedAt]).toEqual(["done", clock.now().toISOString()])
    expect((await store.getTask(task.id))?.state).toEqual({ below: true })
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id])
    await snooze()
    expect((await store.getOccurrence(id))?.status).toBe("snoozed")
  })

  it("is never snoozed by a type answering a text reply with a snooze", async () => {
    const { store, lanes, task, type, runId, larry } = await setup()
    failing(store, "updateOccurrence", applyMark)
    await lanes.tickNotify()
    const id = await runId()
    type.onReply = async (ctx) => ({ snoozeUntil: new Date(ctx.now.getTime() + 3_600_000) })
    await lanes.reply({
      taskId: task.id,
      occurrenceId: id,
      userId: larry.id,
      kind: "text",
      payload: "later",
    })
    expect((await store.getOccurrence(id))?.status).toBe("queued")
    const runs = await store.listOccurrences({ taskId: task.id })
    expect(runs.some((o) => o.dedupeKey.startsWith("snooze:"))).toBe(false)
  })

  it("cannot be snoozed after a crash left it running; recover resumes it", async () => {
    const { store, lanes, notifier, task, runId, larry } = await setup()
    // A crash after the record: the run is left running, fired, nothing applied.
    failing(store, "updateOccurrence", applyMark)
    failing(store, "addEvent", (e: { type: string }) => e.type === "error") // putBack cannot write: left running
    await lanes.tickNotify()
    const id = await runId()
    expect((await store.getOccurrence(id))?.status).toBe("running")
    await expect(
      lanes.reply({
        taskId: task.id,
        occurrenceId: id,
        userId: larry.id,
        kind: "snooze",
        payload: null,
      }),
    ).rejects.toThrow(STILL_FINISHING)
    await lanes.recover()
    await lanes.tickNotify()
    expect((await store.getOccurrence(id))?.status).toBe("done")
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
  })

  it("is finished before the task's next run, which then reads its state: one alert, not two", async () => {
    const { store, clock, lanes, notifier, runs, task, larry } = await setup()
    failing(
      store,
      "updateTask",
      (_id: string, patch: { state?: unknown }) => patch.state !== undefined,
    )
    await lanes.tickNotify() // fires, the state write fails, put back
    expect((await store.getTask(task.id))?.state).toBeNull()
    clock.advance(15 * MIN) // the next run is due on the same tick as the resume
    await lanes.tickNotify()
    expect(runs.n).toBe(2)
    expect(notifier.sent.map((s) => [s.userId, s.message.text])).toEqual([
      [larry.id, "dropped to 5"],
    ])
    expect((await store.getTask(task.id))?.state).toEqual({ below: true })
  })

  it("holds the task's due run, while a run of it is still finishing", async () => {
    const { store, clock, lanes, runs, runId } = await setup({
      schedule: { kind: "poll", every: 5, unit: "minute", start: T0 },
    })
    failing(store, "updateOccurrence", applyMark)
    failing(store, "addEvent", (e: { type: string }) => e.type === "error")
    await lanes.tickNotify() // fired, left running: its tick "died"
    const first = await runId()
    clock.advance(5 * MIN) // the next run is due; the first is still running, not yet stale
    expect(await lanes.tickNotify()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(runs.n).toBe(1)
    expect((await store.getOccurrence(first))?.status).toBe("running")
  })
})

describe("the execute lane and a finishing run", () => {
  it("holds an execute task's due run until the notify tick has finished its last one", async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    const calls: string[] = []
    const executor: Executor = {
      run: async (_spec, id) => {
        calls.push(id)
        return { kind: "success", result: "found", durationMs: 1 }
      },
    }
    const digest: TaskType<unknown> = {
      id: "digest",
      lane: "execute",
      capabilities: ["notify"],
      schedule: ["poll"],
      prepare: async () => ({ prompt: "look" }),
      finish: async () => ({ notify: { text: "found" } }),
    }
    const lanes = new Lanes({
      store,
      clock,
      types: { digest },
      notifier: new FakeNotifier(),
      executor,
    })
    await createTask(
      store,
      actor(larry),
      larry,
      {
        type: digest,
        title: "d",
        config: {},
        schedule: { kind: "poll", every: 5, unit: "minute", start: T0 },
      },
      clock.now(),
    )
    failing(store, "updateOccurrence", applyMark)
    await lanes.tickExecute() // fires, put back to finish
    clock.advance(5 * MIN)
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(calls).toHaveLength(1)
    await lanes.tickNotify() // finishes the first
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(calls).toHaveLength(2)
  })
})

describe("a run whose tick died", () => {
  it("goes back to be resumed once it has been running past the stale limit", async () => {
    const { store, clock, lanes, notifier, runs, runId, larry } = await setup()
    failing(store, "updateOccurrence", applyMark)
    failing(store, "addEvent", (e: { type: string }) => e.type === "error")
    await expect(lanes.tickNotify()).resolves.toBeDefined()
    const id = await runId()
    expect((await store.getOccurrence(id))?.status).toBe("running")
    clock.advance(STALE_RUN_MS - 1)
    await lanes.tickNotify()
    expect((await store.getOccurrence(id))?.status).toBe("running")
    clock.advance(1)
    await lanes.tickNotify()
    expect((await store.getOccurrence(id))?.status).toBe("done")
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
  })

  it("gives a resumed run the full stale window before sweeping it", async () => {
    const { store, clock, lanes, runId } = await setup()
    failing(store, "updateOccurrence", applyMark, 2) // put back, and again on the resume
    await lanes.tickNotify()
    const id = await runId()
    clock.advance(STALE_RUN_MS) // past the first start
    failing(store, "addEvent", (e: { type: string }) => e.type === "error") // the resume dies
    await lanes.tickNotify()
    expect((await store.getOccurrence(id))?.status).toBe("running")
    clock.advance(MIN)
    await lanes.tickNotify() // resumed a minute ago: not swept
    expect((await store.getOccurrence(id))?.status).toBe("running")
  })

  it("leaves a slow run a sweep took over to the resume that finished it", async () => {
    const { store, clock, lanes, notifier, runs, larry } = await setup()
    let inner: unknown = null
    const plan = store.planDelivery.bind(store)
    let first = true
    store.planDelivery = async (occurrenceId, userId, at) => {
      if (first) {
        first = false
        clock.advance(STALE_RUN_MS + 1) // this run is slow; another tick sweeps and resumes it
        inner = await lanes.tickNotify()
      }
      return plan(occurrenceId, userId, at)
    }
    expect(await lanes.tickNotify()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(inner).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
  })

  it("keeps ticking when even the failure cannot be written", async () => {
    const { store, lanes } = await setup()
    failing(store, "addEvent", () => true, 2) // the started line, then the error line
    await expect(lanes.tickNotify()).resolves.toEqual({ ran: 0, failed: 1, skipped: 0 })
  })

  it("never lets a Store error on the started line stop the tick or leave the run running", async () => {
    const { store, lanes, runId } = await setup()
    failing(store, "addEvent", (e: { text: string }) => e.text === "started")
    await expect(lanes.tickNotify()).resolves.toEqual({ ran: 0, failed: 1, skipped: 0 })
    expect((await store.getOccurrence(await runId()))?.status).toBe("failed")
  })
})

describe("a paused or archived task's fired run", () => {
  it("is applied, but what it owes waits for the resume", async () => {
    const { store, clock, lanes, notifier, task, larry } = await setup()
    failing(store, "updateOccurrence", applyMark)
    await lanes.tickNotify() // fired, put back
    await store.updateTask(task.id, { status: "paused", at: T0 })
    clock.advance(30_000)
    await lanes.tickNotify()
    expect((await store.getTask(task.id))?.state).toEqual({ below: true })
    expect(notifier.sent).toHaveLength(0)
    await store.updateTask(task.id, { status: "active", at: T0 })
    await lanes.tickNotify()
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
  })

  it("sends nothing inline when the task was paused while it ran", async () => {
    const { store, lanes, notifier, task, type } = await setup()
    const run = type.run
    type.run = async (ctx) => {
      await store.updateTask(task.id, { status: "paused", at: T0 })
      return run(ctx)
    }
    await lanes.tickNotify()
    expect(notifier.sent).toHaveLength(0)
    expect((await store.listDeliveries({})).map((d) => d.status)).toEqual(["pending"])
  })

  it("drops what an archived task's run owes", async () => {
    const { store, lanes, notifier, task, type } = await setup()
    const run = type.run
    type.run = async (ctx) => {
      await store.updateTask(task.id, { status: "archived", at: T0 })
      return run(ctx)
    }
    await lanes.tickNotify()
    await lanes.tickNotify()
    expect(notifier.sent).toHaveLength(0)
    expect((await store.listDeliveries({})).map((d) => d.status)).toEqual(["failed"])
  })
})

describe("what a recipient may read about the others", () => {
  it("shows a recipient only their own replies and their own consent history", async () => {
    const { store, lanes, task, share, larry, moe, curly } = await setup()
    await share(moe, curly)
    for (const u of [moe, curly]) {
      await lanes.reply({
        taskId: task.id,
        occurrenceId: null,
        userId: u.id,
        kind: "text",
        payload: "hi",
      })
    }
    await lanes.reply({
      taskId: task.id,
      occurrenceId: null,
      userId: curly.id,
      kind: "opt_out",
      payload: null,
    })
    const asMoe = actor(moe)
    const mine = (await visibleReplies(store, asMoe, task.id)) ?? []
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((r) => r.userId === moe.id)).toBe(true)
    const history = (await visibleHistory(store, asMoe, task.id)) ?? []
    expect(history.map((e) => e.detail).join(" ")).not.toContain(curly.id)
    expect(history.some((e) => e.kind === "recipient_accepted" && e.detail === moe.id)).toBe(true)
    expect(history.some((e) => e.kind === "created")).toBe(true)
    const all = (await visibleHistory(store, actor(larry), task.id)) ?? []
    expect(all.some((e) => e.kind === "recipient_opted_out" && e.detail === curly.id)).toBe(true)
    expect((await visibleReplies(store, actor(larry), task.id))?.map((r) => r.userId)).toContain(
      curly.id,
    )
  })
})
