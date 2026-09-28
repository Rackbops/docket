import { describe, expect, it } from "vitest"

import {
  budgetDay,
  budgetHold,
  charge,
  createTask,
  DEFAULT_BUDGET,
  type Executor,
  type JobResult,
  Lanes,
  reached,
  type TaskType,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

describe("the budget day", () => {
  it("runs midnight to midnight Eastern, across both clock changes", () => {
    // 2026-03-02 12:00Z is 07:00 EST.
    expect(budgetDay(new Date(T0))).toEqual({
      day: "2026-03-02",
      start: "2026-03-02T05:00:00.000Z",
      end: "2026-03-03T05:00:00.000Z",
    })
    // 04:30Z on 2026-03-03 is still 23:30 on the 2nd in New York.
    expect(budgetDay(new Date("2026-03-03T04:30:00.000Z")).day).toBe("2026-03-02")
    // Spring forward (2026-03-08): a 23-hour day.
    expect(budgetDay(new Date("2026-03-08T12:00:00.000Z"))).toMatchObject({
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T04:00:00.000Z",
    })
    // Fall back (2026-11-01): a 25-hour day.
    expect(budgetDay(new Date("2026-11-01T12:00:00.000Z"))).toMatchObject({
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T05:00:00.000Z",
    })
    // Month and year ends roll over.
    expect(budgetDay(new Date("2026-12-31T20:00:00.000Z")).end).toBe("2027-01-01T05:00:00.000Z")
  })
})

describe("ceilings", () => {
  it("are reached at the limit, calls first, and null means none", () => {
    const limits = { usd: 2, calls: 20 }
    expect(reached({ usd: 1.99, calls: 19 }, limits)).toBeNull()
    expect(reached({ usd: 2, calls: 0 }, limits)).toBe("usd")
    expect(reached({ usd: 5, calls: 20 }, limits)).toBe("calls")
    expect(reached({ usd: 1e6, calls: 1e6 }, { usd: null, calls: null })).toBeNull()
  })

  it("are the decided defaults: 2 USD and 20 calls a person, 10 USD and 100 calls in all", () => {
    expect(DEFAULT_BUDGET.person).toEqual({ usd: 2, calls: 20 })
    expect(DEFAULT_BUDGET.global).toEqual({ usd: 10, calls: 100 })
  })

  it("count only today's charges, recall's with the runs, and honour a raised ceiling", async () => {
    const store = new MemoryStore()
    const { larry, moe } = await people(store)
    const now = new Date(T0)
    // Yesterday's 19 calls do not count today.
    await charge(store, {
      userId: larry.id,
      taskId: null,
      source: "run",
      calls: 19,
      at: new Date("2026-03-02T04:59:59.000Z"),
    })
    await charge(store, {
      userId: larry.id,
      taskId: null,
      source: "run",
      calls: 19,
      costUsd: 0.1,
      at: now,
    })
    expect(await budgetHold(store, DEFAULT_BUDGET, larry, now)).toBeNull()
    await charge(store, { userId: larry.id, taskId: null, source: "recall", calls: 1, at: now })
    expect(await budgetHold(store, DEFAULT_BUDGET, larry, now)).toMatchObject({
      scope: "person",
      limit: "calls",
      used: { calls: 20 },
      until: "2026-03-03T05:00:00.000Z",
    })
    expect(await budgetHold(store, DEFAULT_BUDGET, moe, now)).toBeNull()
    const raised = {
      ...DEFAULT_BUDGET,
      personFor: (u: { id: string }) => (u.id === larry.id ? { usd: 5, calls: 40 } : null),
    }
    expect(await budgetHold(store, raised, larry, now)).toBeNull()
  })
})

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

const ok: JobResult = { kind: "success", result: "found", totalCostUsd: 0.05, durationMs: 1 }

/** An executor that answers from a queue, then with `ok`; counts its calls. */
function scripted(...answers: JobResult[]) {
  const calls: string[] = []
  const executor: Executor = {
    run: async (_spec, occurrenceId) => {
      calls.push(occurrenceId)
      return answers.shift() ?? ok
    },
  }
  return { executor, calls }
}

async function setup(executor: Executor, budget = DEFAULT_BUDGET) {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const folks = await people(store)
  const lanes = new Lanes({ store, clock, types: { research }, notifier, executor, budget })
  const ask = async (owner = folks.larry, title = "q") => {
    const { task } = await createTask(
      store,
      actor(owner),
      owner,
      { type: research, title, config: {}, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    return task
  }
  return { store, clock, notifier, lanes, ask, ...folks }
}

describe("the execute lane under budgets", () => {
  it("charges each run to its owner: one call and the CLI's estimate", async () => {
    const { executor } = scripted()
    const { store, lanes, ask, larry } = await setup(executor)
    const task = await ask()
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    const [occ] = await store.listOccurrences({ taskId: task.id })
    expect(await store.listUsage()).toMatchObject([
      {
        userId: larry.id,
        taskId: task.id,
        occurrenceId: occ?.id,
        source: "run",
        calls: 1,
        costUsd: 0.05,
      },
    ])
  })

  it("charges a failed run too, and an auth failure not at all", async () => {
    const { executor } = scripted(
      { kind: "turn_cap", detail: "max turns", totalCostUsd: 0.3, durationMs: 1 },
      { kind: "auth_failed", detail: "token rejected", durationMs: 1 },
    )
    const { store, lanes, ask } = await setup(executor)
    await ask(undefined, "a")
    await ask(undefined, "b")
    await lanes.tickExecute()
    expect((await store.listUsage()).map((u) => [u.calls, u.costUsd])).toEqual([[1, 0.3]])
  })

  it("holds a person at their ceiling until midnight Eastern, tells them and the admins once, and runs others", async () => {
    const { executor, calls } = scripted()
    const { store, clock, notifier, lanes, ask, larry, moe, admin } = await setup(executor, {
      ...DEFAULT_BUDGET,
      person: { usd: 2, calls: 1 },
    })
    const first = await ask(larry, "one")
    const second = await ask(larry, "two")
    const moes = await ask(moe, "moe's")
    expect(await lanes.tickExecute()).toEqual({ ran: 2, failed: 0, skipped: 1 })
    expect(calls).toHaveLength(2)
    const status = async (id: string) => (await store.listOccurrences({ taskId: id }))[0]?.status
    expect([await status(first.id), await status(second.id), await status(moes.id)]).toEqual([
      "done",
      "queued",
      "done",
    ])
    const notices = notifier.sent.filter((s) => s.message.text.includes("limit"))
    expect(notices.map((s) => s.userId)).toEqual([admin.id, larry.id])
    expect(notices[1]?.message.text).toContain("1 model calls")

    // Later the same day: still held, and nobody is told twice.
    clock.set("2026-03-03T04:59:00.000Z")
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(notifier.sent.filter((s) => s.message.text.includes("limit"))).toHaveLength(2)

    // Midnight Eastern: the new day has room, and the held run goes, marked late.
    clock.set("2026-03-03T05:00:00.000Z")
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    const [occ] = await store.listOccurrences({ taskId: second.id })
    expect([occ?.status, occ?.late]).toEqual(["done", true])
  })

  it("stops the lane at the global ceiling and tells the admins once", async () => {
    const { executor, calls } = scripted()
    const { store, notifier, lanes, ask, moe, curly, admin } = await setup(executor)
    for (const [who, n] of [
      [moe, 60],
      [curly, 40],
    ] as const) {
      await charge(store, {
        userId: who.id,
        taskId: null,
        source: "run",
        calls: n,
        at: new Date(T0),
      })
    }
    await ask()
    await ask()
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 2 })
    await lanes.tickExecute()
    expect(calls).toHaveLength(0)
    const notices = notifier.sent.filter((s) => s.message.text.includes("limit"))
    expect(notices.map((s) => s.userId)).toEqual([admin.id])
    expect(notices[0]?.message.text).toContain("Everyone together")
  })

  it("requeues a run that hits the usage limit, charges nobody, and waits for the reset", async () => {
    const reset = "2026-03-02T15:00:00.000Z"
    const { executor, calls } = scripted({
      kind: "usage_limit",
      detail: "You've hit your session limit",
      resetsAt: reset,
      durationMs: 1,
    })
    const { store, clock, notifier, lanes, ask, admin } = await setup(executor)
    const task = await ask()
    await ask()
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 2 })
    expect(calls).toHaveLength(1)
    const [occ] = await store.listOccurrences({ taskId: task.id })
    expect(occ?.status).toBe("queued")
    expect(await store.listUsage()).toEqual([])
    expect(notifier.sent.map((s) => s.userId)).toEqual([admin.id])
    expect(notifier.sent[0]?.message.text).toContain(`until ${reset}`)

    clock.set("2026-03-02T14:59:00.000Z")
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 2 })
    expect(calls).toHaveLength(1)

    clock.set(reset)
    expect(await lanes.tickExecute()).toEqual({ ran: 2, failed: 0, skipped: 0 })
    expect(notifier.sent.filter((s) => s.userId === admin.id)).toHaveLength(1)
  })

  it("waits an hour after a usage limit that named no reset", async () => {
    const { executor } = scripted({ kind: "usage_limit", detail: "limit", durationMs: 1 })
    const { clock, lanes, ask } = await setup(executor)
    await ask()
    await lanes.tickExecute()
    clock.set("2026-03-02T12:59:59.000Z")
    expect(await lanes.tickExecute()).toMatchObject({ ran: 0, skipped: 1 })
    clock.set("2026-03-02T13:00:00.000Z")
    expect(await lanes.tickExecute()).toMatchObject({ ran: 1 })
  })

  it("tells the admins even when the person's DMs are closed, and keeps the tick going", async () => {
    const { executor } = scripted()
    const store = new MemoryStore()
    const { larry, moe, admin } = await people(store)
    const sent: string[] = []
    const lanes = new Lanes({
      store,
      clock: new FakeClock(new Date(T0)),
      types: { research },
      notifier: {
        sendDm: async (userId) => {
          if (userId === larry.id) throw new Error("closed DMs")
          sent.push(userId)
          return { messageId: `m${sent.length}` }
        },
      },
      executor,
      budget: { ...DEFAULT_BUDGET, person: { usd: null, calls: 0 } },
    })
    for (const who of [larry, moe]) {
      await createTask(
        store,
        actor(who),
        who,
        { type: research, title: "q", config: {}, schedule: { kind: "once", at: T0 } },
        new Date(T0),
      )
    }
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 2 })
    expect(sent).toEqual([admin.id, admin.id, moe.id])
  })

  it("keeps a snooze pressed while the run was in flight when the usage limit sends it back", async () => {
    let lanesRef: Lanes | undefined
    let occurrenceId = ""
    let taskId = ""
    let ownerId = ""
    const executor: Executor = {
      run: async (_spec, id) => {
        await lanesRef?.reply({
          taskId,
          occurrenceId: id,
          userId: ownerId,
          kind: "snooze",
          payload: { hours: 1 },
        })
        occurrenceId = id
        return { kind: "usage_limit", detail: "limit", durationMs: 1 }
      },
    }
    const snoozy: TaskType<unknown> = {
      ...research,
      onReply: async (ctx) => ({ snoozeUntil: new Date(ctx.now.getTime() + 3_600_000) }),
    }
    const store = new MemoryStore()
    const { larry } = await people(store)
    const lanes = new Lanes({
      store,
      clock: new FakeClock(new Date(T0)),
      types: { research: snoozy },
      notifier: new FakeNotifier(),
      executor,
    })
    lanesRef = lanes
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: snoozy, title: "q", config: {}, schedule: { kind: "once", at: T0 } },
      new Date(T0),
    )
    taskId = task.id
    ownerId = larry.id
    await lanes.tickExecute()
    expect((await store.getOccurrence(occurrenceId))?.status).toBe("snoozed")
    const queued = await store.listOccurrences({ taskId: task.id, status: "queued" })
    expect(queued.map((o) => o.dedupeKey)).toEqual([`snooze:${occurrenceId}`])
  })

  it("tells the admins once per window when no reset time comes, and caps a far reset at a day", async () => {
    const noReset: JobResult = { kind: "usage_limit", detail: "limit", durationMs: 1 }
    const { executor } = scripted(noReset, noReset, {
      kind: "usage_limit",
      detail: "weekly limit",
      resetsAt: "2027-03-02T12:00:00.000Z",
      durationMs: 1,
    })
    const { clock, notifier, lanes, ask, admin } = await setup(executor)
    await ask()
    await lanes.tickExecute() // 12:00, window 1 begins
    clock.set("2026-03-02T13:00:00.000Z")
    await lanes.tickExecute() // same five-hour window: no second notice
    expect(notifier.sent.filter((s) => s.userId === admin.id)).toHaveLength(1)
    clock.set("2026-03-02T14:00:00.000Z")
    await lanes.tickExecute() // a reset a year out
    expect(notifier.sent.at(-1)?.message.text).toContain("until 2027-03-02T12:00:00.000Z")
    clock.set("2026-03-03T13:59:00.000Z")
    expect(await lanes.tickExecute()).toMatchObject({ ran: 0, skipped: 1 })
    clock.set("2026-03-03T14:00:00.000Z")
    expect(await lanes.tickExecute()).toMatchObject({ ran: 1 })
  })

  it("never holds the notify lane", async () => {
    const store = new MemoryStore()
    const { larry } = await people(store)
    const reminder: TaskType<unknown> = {
      id: "reminder",
      lane: "notify",
      capabilities: ["notify"],
      schedule: ["once"],
      run: async () => ({ notify: { text: "hi" } }),
    }
    const lanes = new Lanes({
      store,
      clock: new FakeClock(new Date(T0)),
      types: { reminder },
      notifier: new FakeNotifier(),
      executor: scripted().executor,
      budget: { person: { usd: 0, calls: 0 }, global: { usd: 0, calls: 0 } },
    })
    await createTask(
      store,
      actor(larry),
      larry,
      { type: reminder, title: "r", config: {}, schedule: { kind: "once", at: T0 } },
      new Date(T0),
    )
    expect(await lanes.tickNotify()).toEqual({ ran: 1, failed: 0, skipped: 0 })
  })
})
