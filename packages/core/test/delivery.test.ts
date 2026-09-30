import { describe, expect, it } from "vitest"

import {
  createTask,
  DeliveryFailedError,
  ExecutorUnavailableError,
  invite,
  Lanes,
  type Notifier,
  reschedule,
  respondToInvite,
  type Schedule,
  type TaskType,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

/**
 * Alerts once when a value it reads crosses below 10, and remembers that it did: the shape of
 * the price tracker, whose stored crossing would swallow a lost alert (plan item 58).
 */
function crossing(read: () => number, runs: { n: number }) {
  const type: TaskType<unknown> = {
    id: "crossing",
    lane: "notify",
    capabilities: ["notify"],
    schedule: ["poll", "calendar"],
    run: async (ctx) => {
      runs.n++
      const value = read()
      const below = value < 10
      const was = (ctx.state as { below?: boolean } | null)?.below ?? false
      return {
        state: { below },
        series: [{ value }],
        ...(below && !was ? { notify: { text: `dropped to ${value}` } } : {}),
        summary: String(value),
      }
    },
  }
  return type
}

const daily: Schedule = { kind: "calendar", every: 1, unit: "day", start: "2026-03-01" }
const quarterHourly: Schedule = { kind: "poll", every: 15, unit: "minute", start: T0 }

/** A notifier whose sends to some users fail the way the test says. */
class PickyNotifier extends FakeNotifier {
  readonly failFor = new Map<string, () => Error>()
  override async sendDm(userId: string, message: Parameters<Notifier["sendDm"]>[1]) {
    const fail = this.failFor.get(userId)
    if (fail) throw fail()
    return super.sendDm(userId, message)
  }
}

async function setup(value = { v: 5 }) {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new PickyNotifier()
  const folks = await people(store)
  const runs = { n: 0 }
  const type = crossing(() => value.v, runs)
  const lanes = new Lanes({ store, clock, types: { crossing: type }, notifier })
  const { task } = await createTask(
    store,
    actor(folks.larry),
    folks.larry,
    { type, title: "widget", config: {}, schedule: quarterHourly },
    clock.now(),
  )
  const share = async (...users: { id: string }[]) => {
    for (const u of users) {
      await invite(store, actor(folks.larry), task, u.id, clock.now())
      await respondToInvite(store, task, u.id, "accept", clock.now())
    }
  }
  return { store, clock, notifier, lanes, task, runs, value, share, ...folks }
}

const closed = () => new DeliveryFailedError("recipient cannot be messaged", true)

describe("the abort signal", () => {
  it("runs nothing once aborted: the due run stays queued and unstarted", async () => {
    const { store, lanes, notifier, runs, task } = await setup()
    const abort = new AbortController()
    abort.abort()
    expect(await lanes.tickNotify(abort.signal)).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(runs.n).toBe(0)
    expect(notifier.sent).toHaveLength(0)
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect([run?.status, run?.startedAt]).toEqual(["queued", null])
  })

  it("drops an outcome the abort reached before it was stored, so the retry applies it once", async () => {
    const { store, lanes, notifier, runs, task, value } = await setup()
    const abort = new AbortController()
    // The abort lands while the type is running (a page read cut short by a restart).
    const type = crossing(() => {
      abort.abort()
      return value.v
    }, runs)
    const aborting = new Lanes({
      store,
      clock: new FakeClock(new Date(T0)),
      types: { crossing: type },
      notifier,
    })
    expect(await aborting.tickNotify(abort.signal)).toMatchObject({ ran: 0, skipped: 1 })
    expect(runs.n).toBe(1)
    expect((await store.getTask(task.id))?.state).toBeNull()
    expect(await store.listSeries(task.id)).toHaveLength(0)
    expect(notifier.sent).toHaveLength(0)
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect([run?.status, run?.startedAt]).toEqual(["queued", null])

    expect(await lanes.tickNotify()).toMatchObject({ ran: 1 })
    expect((await store.getTask(task.id))?.state).toEqual({ below: true })
    expect((await store.listSeries(task.id)).map((p) => p.value)).toEqual([5])
    expect(notifier.sent.map((s) => s.message.text)).toEqual(["dropped to 5"])
  })

  it("stops sending once aborted mid-delivery, and the next tick finishes it without a rerun", async () => {
    const { store, lanes, notifier, runs, task, share, larry, moe, curly } = await setup()
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
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect(run?.status).toBe("queued")

    notifier.sendDm = send
    expect(await lanes.tickNotify()).toMatchObject({ ran: 1 })
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id, curly.id])
    expect((await store.getOccurrence(run?.id ?? ""))?.status).toBe("done")
  })
})

describe("delivery per recipient", () => {
  it("never lets one recipient who cannot be messaged block the others", async () => {
    const { lanes, notifier, share, larry, moe, curly } = await setup()
    await share(moe, curly)
    notifier.failFor.set(moe.id, closed)
    expect(await lanes.tickNotify()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, curly.id])
  })

  it("records each recipient's failure, retries only them, and gives up after the limit", async () => {
    const { store, clock, lanes, notifier, runs, task, share, larry, moe, curly } = await setup()
    await share(moe, curly)
    notifier.failFor.set(moe.id, closed)
    await lanes.tickNotify()
    const [run] = await store.listOccurrences({ taskId: task.id })
    const id = run?.id ?? ""
    expect(
      (await store.listDeliveries({ occurrenceId: id })).map((d) => [
        d.userId,
        d.status,
        d.attempts,
        d.error,
      ]),
    ).toEqual([
      [larry.id, "sent", 0, null],
      [moe.id, "failed", 1, "recipient cannot be messaged"],
      [curly.id, "sent", 0, null],
    ])
    const lines = (await store.listEvents(id)).filter((e) => e.agent === "notifier")
    expect(lines.map((e) => [e.type, e.text.split(" ")[0]])).toEqual([
      ["delivered", larry.id],
      ["undelivered", moe.id],
      ["delivered", curly.id],
    ])
    expect((await store.getOccurrence(id))?.status).toBe("queued")

    clock.advance(60_000)
    await lanes.tickNotify()
    clock.advance(60_000)
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, curly.id])
    const moeClaim = (await store.listDeliveries({ occurrenceId: id })).find(
      (d) => d.userId === moe.id,
    )
    expect([moeClaim?.status, moeClaim?.attempts]).toEqual(["failed", 3])
    expect((await store.getOccurrence(id))?.status).toBe("done")
    // The run is finished, so the schedule's next one exists.
    expect((await store.listOccurrences({ taskId: task.id, status: "queued" })).length).toBe(1)
  })

  it("never resends a send that may have gone out, or a claim a crash left behind", async () => {
    const { store, clock, lanes, notifier, task, share, larry, moe, curly } = await setup()
    await share(moe, curly)
    notifier.failFor.set(moe.id, () => new Error("socket hang up"))
    notifier.failFor.set(curly.id, closed)
    await lanes.tickNotify()
    const [run] = await store.listOccurrences({ taskId: task.id })
    const id = run?.id ?? ""
    // Curly is owed a retry; a sender that died holds his claim now.
    notifier.failFor.clear()
    expect(await store.claimDelivery(id, curly.id, clock.now().toISOString())).not.toBeNull()
    clock.advance(60_000)
    await lanes.tickNotify()
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
    expect(
      (await store.listDeliveries({ status: "unconfirmed" })).map((d) => [d.userId, d.error]),
    ).toEqual([
      [moe.id, "socket hang up"],
      [curly.id, "claimed, never settled"],
    ])
    expect((await store.getOccurrence(id))?.status).toBe("done")
  })

  it("holds a deferred send without counting an attempt, and sends it on a later tick", async () => {
    const { store, clock, lanes, notifier, runs, task, share, larry, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, () => new ExecutorUnavailableError("delivery to moe is paused"))
    await lanes.tickNotify()
    const [run] = await store.listOccurrences({ taskId: task.id })
    const claim = (await store.listDeliveries({ occurrenceId: run?.id ?? "" }))[1]
    expect([claim?.userId, claim?.status, claim?.attempts]).toEqual([moe.id, "failed", 0])
    notifier.failFor.clear()
    clock.advance(60_000)
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id])
  })
})

describe("the retry ordering", () => {
  it("retries a failed alert without running the type again or losing the alert", async () => {
    const { store, clock, lanes, notifier, runs, task, larry } = await setup()
    notifier.failFor.set(larry.id, () => new DeliveryFailedError("Discord said 500, not sent"))
    await lanes.tickNotify()
    // The crossing is stored once and the alert is owed, not lost.
    expect((await store.getTask(task.id))?.state).toEqual({ below: true })
    expect(notifier.sent).toHaveLength(0)
    notifier.failFor.clear()
    clock.advance(60_000)
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => [s.userId, s.message.text])).toEqual([
      [larry.id, "dropped to 5"],
    ])
    expect((await store.listSeries(task.id)).map((p) => p.value)).toEqual([5])
  })

  it("resumes at delivery after a crash once the outcome is recorded", async () => {
    const { store, lanes, notifier, runs, task, larry } = await setup()
    notifier.failFor.set(larry.id, () => new ExecutorUnavailableError("host restarting"))
    await lanes.tickNotify()
    const [run] = await store.listOccurrences({ taskId: task.id })
    // The process dies while it retries the send: the run is left running.
    await store.updateOccurrence(run?.id ?? "", { status: "running" })
    expect(await lanes.recover()).toEqual([run?.id])
    notifier.failFor.clear()
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect((await store.listSeries(task.id)).length).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
  })

  it("waits out a pause the host made for these failures, then delivers on resume", async () => {
    const { store, clock, lanes, notifier, runs, task, share, larry, moe } = await setup()
    await share(moe)
    // The host's rule (plan 5.5): the third failure in a row pauses the task.
    let failures = 0
    notifier.failFor.set(moe.id, () => {
      failures++
      if (failures === 3) void store.updateTask(task.id, { status: "paused", at: T0 })
      return closed()
    })
    for (let i = 0; i < 4; i++) {
      await lanes.tickNotify()
      clock.advance(60_000)
    }
    expect(failures).toBe(3)
    const [run] = await store.listOccurrences({ taskId: task.id })
    expect(run?.status).toBe("queued")
    const claim = (await store.listDeliveries({ occurrenceId: run?.id ?? "" }))[1]
    expect([claim?.status, claim?.attempts]).toEqual(["failed", 0])

    notifier.failFor.clear()
    await store.updateTask(task.id, { status: "active", at: clock.now().toISOString() })
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id])
    expect((await store.getOccurrence(run?.id ?? ""))?.status).toBe("done")
  })
})

describe("paused tasks and schedule edits", () => {
  it("never runs a due occurrence of a paused task, and runs it once resumed", async () => {
    const { store, clock, lanes, notifier, runs, task } = await setup()
    await store.updateTask(task.id, { status: "paused", at: T0 })
    clock.advance(60_000)
    expect(await lanes.tickNotify()).toEqual({ ran: 0, failed: 0, skipped: 0 })
    expect(runs.n).toBe(0)
    expect((await store.listOccurrences({ taskId: task.id }))[0]?.status).toBe("queued")
    await store.updateTask(task.id, { status: "active", at: T0 })
    expect(await lanes.tickNotify()).toMatchObject({ ran: 1 })
    expect(notifier.sent).toHaveLength(1)
  })

  it("keeps a queued snooze's run when the schedule changes", async () => {
    const { store, clock, larry } = await setup()
    const reminder: TaskType<unknown> = {
      id: "reminder",
      lane: "notify",
      capabilities: ["notify"],
      schedule: ["calendar"],
      run: async () => ({ notify: { text: "stretch", actions: ["snooze"] } }),
      onReply: async (ctx) => ({ snoozeUntil: new Date(ctx.now.getTime() + 3_600_000) }),
    }
    const withReminder = new Lanes({
      store,
      clock,
      types: { reminder },
      notifier: new FakeNotifier(),
    })
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: reminder, title: "stretch", config: {}, schedule: daily },
      clock.now(),
    )
    clock.set("2026-03-02T14:00:30.000Z")
    await withReminder.tickNotify()
    const [fired] = await store.listOccurrences({ taskId: task.id, status: "done" })
    await withReminder.reply({
      taskId: task.id,
      occurrenceId: fired?.id ?? null,
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
