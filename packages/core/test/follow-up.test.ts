import { describe, expect, it } from "vitest"

import {
  createTask,
  DEFAULT_BUDGET,
  type Executor,
  FOLLOW_UP_PREFIX,
  followUpKey,
  invite,
  isOffSchedule,
  type JobResult,
  Lanes,
  MAX_FOLLOW_UPS,
  parseRunRecord,
  reschedule,
  respondToInvite,
  type Store,
  type TaskType,
  visibleFindings,
  ZWSP,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

/**
 * A two-phase execute type, the shape of a research request: the first run asks for a follow-up
 * and remembers its draft in state; the follow-up sends the answer, stores findings and ends.
 */
const twoPhase: TaskType<unknown> = {
  id: "two",
  lane: "execute",
  capabilities: ["notify"],
  schedule: ["once", "calendar"],
  prepare: async (ctx) => ({ prompt: ctx.state === null ? "draft" : "review" }),
  finish: async (ctx, result) => {
    if (result.kind !== "success") return { summary: result.kind, complete: true }
    if (ctx.state === null) {
      return { state: { phase: "review" }, followUp: {}, summary: "drafted" }
    }
    return {
      state: { phase: "done" },
      notify: { text: "the answer" },
      findings: [
        { text: "claim a", source: "https://a.example", tags: ["two"] },
        { text: "claim b" },
      ],
      complete: true,
      summary: "reviewed",
    }
  },
}

/** Asks for a follow-up every time: the guard must stop it. */
const forever: TaskType<unknown> = {
  id: "forever",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["once"],
  run: async () => ({ followUp: {}, summary: "again" }),
}

const ok: JobResult = { kind: "success", result: "ok", totalCostUsd: 0.1, durationMs: 1 }

function scripted(...answers: JobResult[]) {
  const prompts: string[] = []
  const executor: Executor = {
    run: async (spec) => {
      prompts.push(spec.prompt)
      return answers.shift() ?? ok
    },
  }
  return { executor, prompts }
}

async function setup(
  executor: Executor,
  budget = DEFAULT_BUDGET,
  store: Store = new MemoryStore(),
) {
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const folks = await people(store as MemoryStore)
  const lanes = new Lanes({
    store,
    clock,
    types: { two: twoPhase, forever },
    notifier,
    executor,
    budget,
  })
  const { task } = await createTask(
    store,
    actor(folks.larry),
    folks.larry,
    { type: twoPhase, title: "q", config: {}, schedule: { kind: "once", at: T0 } },
    clock.now(),
  )
  return { store, clock, notifier, lanes, task, ...folks }
}

describe("a follow-up run", () => {
  it("is queued off the schedule when the first run fires, then runs on the next tick", async () => {
    const { executor, prompts } = scripted()
    const { store, lanes, task } = await setup(executor)
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    const runs = await store.listOccurrences({ taskId: task.id })
    expect(runs.map((o) => [o.status, o.dedupeKey])).toEqual([
      ["done", expect.stringMatching(/^sched:/)],
      ["queued", followUpKey(runs[0]?.id ?? "")],
    ])
    expect(runs[1]?.dueAt).toBe(T0)
    expect(isOffSchedule(runs[1]?.dedupeKey ?? "")).toBe(true)
    expect((await store.getTask(task.id))?.state).toEqual({ phase: "review" })

    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(prompts).toEqual(["draft", "review"])
    expect((await store.getTask(task.id))?.status).toBe("done")
    // Nothing more is queued: the follow-up asked for none, and `once` has no next run.
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 0 })
  })

  it("is charged to the owner like any model run", async () => {
    const { executor } = scripted()
    const { store, lanes, larry } = await setup(executor)
    await lanes.tickExecute()
    await lanes.tickExecute()
    const usage = await store.listUsage({ userId: larry.id })
    expect(usage.map((u) => [u.calls, u.costUsd])).toEqual([
      [1, 0.1],
      [1, 0.1],
    ])
    expect(new Set(usage.map((u) => u.occurrenceId)).size).toBe(2)
  })

  it("is held at the owner's ceiling, like any model run, and goes after midnight", async () => {
    const { executor, prompts } = scripted()
    const { store, clock, notifier, lanes, task, larry } = await setup(executor, {
      ...DEFAULT_BUDGET,
      person: { usd: null, calls: 1 },
    })
    await lanes.tickExecute()
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(prompts).toEqual(["draft"])
    expect(
      notifier.sent.some((s) => s.userId === larry.id && s.message.text.includes("limit")),
    ).toBe(true)
    clock.set("2026-03-03T05:00:00.000Z")
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect((await store.getTask(task.id))?.status).toBe("done")
  })

  it("waits while the run that asked for it is still finishing", async () => {
    const { executor, prompts } = scripted()
    const { store, lanes, task } = await setup(executor)
    await lanes.tickExecute()
    const [first, follow] = await store.listOccurrences({ taskId: task.id })
    // As if the first run's last steps had failed: fired, put back, not finished.
    await store.updateOccurrence(first?.id ?? "", { status: "queued", finishedAt: null })
    expect(await lanes.tickExecute()).toEqual({ ran: 0, failed: 0, skipped: 1 })
    expect(prompts).toEqual(["draft"])
    // The notify tick resumes the first run; then the follow-up goes.
    await lanes.tickNotify()
    expect(await lanes.tickExecute()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect((await store.getOccurrence(follow?.id ?? ""))?.status).toBe("done")
  })

  it("is queued once however often its run's outcome is applied", async () => {
    const { executor } = scripted()
    const { store, lanes, task } = await setup(executor)
    await lanes.tickExecute()
    const [first] = await store.listOccurrences({ taskId: task.id })
    const record = parseRunRecord(first?.record)
    expect(record?.outcome.followUp).toEqual({})
    // Resume the fired run from its record, as after a crash.
    await store.updateOccurrence(first?.id ?? "", {
      status: "queued",
      finishedAt: null,
      record: { ...(record ?? ({} as never)), appliedAt: null },
    })
    await lanes.tickNotify()
    const runs = await store.listOccurrences({ taskId: task.id })
    expect(runs.filter((o) => o.dedupeKey.startsWith(FOLLOW_UP_PREFIX))).toHaveLength(1)
  })

  it("survives a schedule edit, as a snooze's run does", async () => {
    const { executor } = scripted()
    const { store, clock, lanes, task, larry } = await setup(executor)
    await lanes.tickExecute()
    const current = await store.getTask(task.id)
    if (!current) throw new Error("no task")
    await reschedule(
      store,
      current,
      larry,
      { kind: "once", at: "2026-03-05T12:00:00.000Z" },
      larry.id,
      clock.now(),
    )
    const queued = await store.listOccurrences({ taskId: task.id, status: "queued" })
    expect(queued.map((o) => o.dedupeKey.split(":")[0]).sort()).toEqual(["followup", "sched"])
  })

  it("is not queued when the same outcome completes the task", async () => {
    const both: TaskType<unknown> = {
      ...forever,
      id: "both",
      run: async () => ({ followUp: {}, complete: true }),
    }
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    const lanes = new Lanes({ store, clock, types: { both }, notifier: new FakeNotifier() })
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: both, title: "b", config: {}, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    await lanes.tickNotify()
    expect(await store.listOccurrences({ taskId: task.id })).toHaveLength(1)
    expect((await store.getTask(task.id))?.status).toBe("done")
  })

  it(`stops after ${MAX_FOLLOW_UPS} in a row and says so`, async () => {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    const notifier = new FakeNotifier()
    const lanes = new Lanes({ store, clock, types: { forever }, notifier })
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      {
        type: forever,
        title: "f @everyone <@123>",
        config: {},
        schedule: { kind: "once", at: T0 },
      },
      clock.now(),
    )
    for (let i = 0; i < MAX_FOLLOW_UPS + 3; i++) await lanes.tickNotify()
    const runs = await store.listOccurrences({ taskId: task.id })
    expect(runs).toHaveLength(MAX_FOLLOW_UPS + 1)
    expect(runs.every((o) => o.status === "done")).toBe(true)
    const last = runs[runs.length - 1]
    const events = await store.listEvents(last?.id ?? "")
    expect(events.some((e) => e.type === "error" && e.text.includes("no follow-up"))).toBe(true)
    // Ended, not stranded active with nothing queued.
    expect((await store.getTask(task.id))?.status).toBe("done")
    expect(notifier.sent.filter((m) => m.userId === larry.id).map((m) => m.message.text)).toEqual([
      expect.stringContaining("it asked for more than 5 runs in a row"),
    ])
    // The title is the owner's text: cleaned, so it cannot ping anyone.
    const said = notifier.sent.map((m) => m.message.text).join("\n")
    expect(said).toContain(`"f @${ZWSP}everyone @${ZWSP}123"`)
    expect(said).not.toContain("@everyone")
    expect(said).not.toContain("<@123>")
  })

  it("from a record carrying a malformed follow-up is no record at all", () => {
    const base = { costUsd: null, firedAt: T0, appliedAt: null, resumes: 0 }
    expect(parseRunRecord({ ...base, outcome: { followUp: { at: T0 } } })).not.toBeNull()
    expect(parseRunRecord({ ...base, outcome: { followUp: { at: "soon" } } })).toBeNull()
    expect(parseRunRecord({ ...base, outcome: { followUp: true } })).toBeNull()
  })

  it("is due at the instant the outcome names", async () => {
    const later: TaskType<unknown> = {
      ...forever,
      id: "later",
      run: async (ctx) =>
        ctx.state === null
          ? { state: 1, followUp: { at: "2026-03-02T13:00:00.000Z" } }
          : { complete: true },
    }
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    const lanes = new Lanes({ store, clock, types: { later }, notifier: new FakeNotifier() })
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: later, title: "l", config: {}, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    await lanes.tickNotify()
    expect(await lanes.tickNotify()).toMatchObject({ ran: 0 })
    clock.set("2026-03-02T13:00:00.000Z")
    expect(await lanes.tickNotify()).toMatchObject({ ran: 1 })
    expect((await store.getTask(task.id))?.status).toBe("done")
  })
})

describe("findings", () => {
  it("are stored when the outcome is applied, keyed by the run, with the task's owner and type", async () => {
    const { executor } = scripted()
    const { store, lanes, task, larry } = await setup(executor)
    await lanes.tickExecute()
    expect(await store.listFindings({ taskId: task.id })).toEqual([])
    await lanes.tickExecute()
    const follow = (await store.listOccurrences({ taskId: task.id }))[1]
    expect(await store.listFindings({ taskId: task.id })).toMatchObject([
      {
        ownerId: larry.id,
        occurrenceId: follow?.id,
        key: `${follow?.id}:0`,
        type: "two",
        text: "claim a",
        tags: ["two"],
        source: "https://a.example",
      },
      { key: `${follow?.id}:1`, text: "claim b", tags: [], source: null },
    ])
  })

  it("are stored once when a fired run is resumed", async () => {
    const { executor } = scripted()
    const { store, lanes, task } = await setup(executor)
    await lanes.tickExecute()
    await lanes.tickExecute()
    const follow = (await store.listOccurrences({ taskId: task.id }))[1]
    const record = parseRunRecord(follow?.record)
    await store.updateOccurrence(follow?.id ?? "", {
      status: "queued",
      finishedAt: null,
      record: { ...(record ?? ({} as never)), appliedAt: null },
    })
    await lanes.tickNotify()
    expect(await store.listFindings({ taskId: task.id })).toHaveLength(2)
  })

  it("are seen by the owner, an accepted recipient and an admin; nobody else", async () => {
    const { executor } = scripted()
    const { store, clock, lanes, task, larry, moe, curly, admin } = await setup(executor)
    await invite(store, actor(larry), task, moe.id, clock.now())
    await respondToInvite(store, task, moe.id, "accept", clock.now())
    await lanes.tickExecute()
    await lanes.tickExecute()
    for (const who of [larry, moe, admin]) {
      expect(await visibleFindings(store, actor(who), task.id)).toHaveLength(2)
    }
    expect(await visibleFindings(store, actor(curly), task.id)).toBeNull()
    expect(
      await visibleFindings(store, actor(larry), task.id, { since: "2099-01-01T00:00:00.000Z" }),
    ).toEqual([])
  })

  it("are all deleted for their owner by deleteFindings, the Store's forget-me call", async () => {
    const { executor } = scripted()
    const { store, lanes, larry } = await setup(executor)
    await lanes.tickExecute()
    await lanes.tickExecute()
    expect(await store.deleteFindings(larry.id)).toBe(2)
    expect(await store.listFindings({ ownerId: larry.id })).toEqual([])
  })

  it("with a key of their own are stored once per task, whichever run finds them (do-not-resurface)", async () => {
    const keyed: TaskType<unknown> = {
      ...forever,
      id: "keyed",
      schedule: ["poll"],
      run: async () => ({
        findings: [{ text: "same item", source: "https://x.example/1", key: "sha-of-url" }],
      }),
    }
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    const lanes = new Lanes({ store, clock, types: { keyed }, notifier: new FakeNotifier() })
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      {
        type: keyed,
        title: "k",
        config: {},
        schedule: { kind: "poll", every: 15, unit: "minute", start: T0 },
      },
      clock.now(),
    )
    await lanes.tickNotify()
    clock.advance(15 * 60_000)
    await lanes.tickNotify()
    expect((await store.listOccurrences({ taskId: task.id, status: "done" })).length).toBe(2)
    expect((await store.listFindings({ taskId: task.id })).map((f) => f.key)).toEqual([
      `${task.id}:sha-of-url`,
    ])
  })

  it("from a reply are keyed by the reply", async () => {
    const answering: TaskType<unknown> = {
      ...forever,
      id: "answering",
      run: async () => ({ notify: { text: "?", actions: ["done"] } }),
      onReply: async () => ({ findings: [{ text: "from the reply" }] }),
    }
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const { larry } = await people(store)
    const lanes = new Lanes({ store, clock, types: { answering }, notifier: new FakeNotifier() })
    const { task } = await createTask(
      store,
      actor(larry),
      larry,
      { type: answering, title: "a", config: {}, schedule: { kind: "once", at: T0 } },
      clock.now(),
    )
    await lanes.tickNotify()
    const [run] = await store.listOccurrences({ taskId: task.id })
    await lanes.reply({
      taskId: task.id,
      occurrenceId: run?.id ?? null,
      userId: larry.id,
      kind: "text",
      payload: "hi",
    })
    const [reply] = await store.listReplies(task.id)
    expect((await store.listFindings({ taskId: task.id })).map((f) => f.key)).toEqual([
      `reply:${reply?.id}:0`,
    ])
  })
})

describe("a follow-up asked for by a run that never finished applying", () => {
  it("is never queued, so no run starts on state the outcome did not write", async () => {
    const inner = new MemoryStore()
    // Every state write fails: the run fires, cannot apply, and is given up after MAX_RESUMES.
    const store: Store = Object.assign(Object.create(inner), {
      updateTask: async (id: string, patch: Parameters<Store["updateTask"]>[1]) => {
        if (patch.state !== undefined) throw new Error("disk full")
        return inner.updateTask(id, patch)
      },
    })
    const { executor, prompts } = scripted()
    const { lanes, task } = await setup(executor, DEFAULT_BUDGET, store)
    await lanes.tickExecute()
    for (let i = 0; i < 5; i++) await lanes.tickNotify()
    const runs = await inner.listOccurrences({ taskId: task.id })
    expect(runs.map((o) => [o.status, o.error?.startsWith("could not finish")])).toEqual([
      ["done", true],
    ])
    expect(runs.some((o) => o.dedupeKey.startsWith(FOLLOW_UP_PREFIX))).toBe(false)
    await lanes.tickExecute()
    expect(prompts).toEqual(["draft"])
  })
})
