import { describe, expect, it } from "vitest"

import {
  createTask,
  decodeReplyRef,
  encodeReplyRef,
  invite,
  Lanes,
  replyButtons,
  replyForRef,
  respondToInvite,
  type TaskType,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, MemoryStore, people, T0 } from "./helpers.js"

const reminder: TaskType<{ text: string }> = {
  id: "reminder",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["once"],
  run: async (ctx) => ({ notify: { text: ctx.config.text, actions: ["done", "snooze"] } }),
  onReply: async (ctx) =>
    ctx.reply.kind === "done"
      ? { summary: "done" }
      : { snoozeUntil: new Date(ctx.now.getTime() + 3_600_000) },
}

describe("reply references", () => {
  it("round-trip every button kind, with a decision's choice", () => {
    const ref = { taskId: "t1", occurrenceId: "o7" }
    expect(encodeReplyRef({ ...ref, kind: "done" })).toBe("d.o.o7")
    expect(encodeReplyRef({ taskId: "t1", occurrenceId: null, kind: "accept" })).toBe("a.t.t1")
    expect(encodeReplyRef({ ...ref, kind: "decision", choice: "keep it.now" })).toBe(
      "c.o.o7.keep it.now",
    )
    expect(decodeReplyRef("c.o.o7.keep it.now")).toEqual({
      kind: "decision",
      scope: "o",
      id: "o7",
      choice: "keep it.now",
    })
    expect(decodeReplyRef("q.o.o7")).toEqual({ kind: "opt_out", scope: "o", id: "o7" })
  })

  it("rejects what it did not make", () => {
    for (const bad of ["", "z.o.o7", "d.x.o7", "d.o.", "d.o.o7.extra", "c.o.o7"]) {
      expect(decodeReplyRef(bad), bad).toBeNull()
    }
    expect(() => encodeReplyRef({ taskId: "t", occurrenceId: "a.b", kind: "done" })).toThrow()
    expect(() => encodeReplyRef({ taskId: "t", occurrenceId: "o", kind: "decision" })).toThrow()
  })

  it("renders a message's actions as labelled buttons, one per decision choice", () => {
    const buttons = replyButtons({
      text: "Renew the domain?",
      actions: ["decision", "snooze", "opt_out"],
      decisions: ["keep", "cancel"],
      ref: { taskId: "t1", occurrenceId: "o2" },
    })
    expect(buttons.map((b) => [b.label, b.ref])).toEqual([
      ["keep", "c.o.o2.keep"],
      ["cancel", "c.o.o2.cancel"],
      ["Snooze 1h", "s.o.o2"],
      ["Stop sending me this", "q.o.o2"],
    ])
    expect(replyButtons({ text: "no ref", actions: ["done"] })).toEqual([])
    const twice = replyButtons({
      text: "twice",
      actions: ["done", "done", "decision"],
      decisions: ["keep", "keep"],
      ref: { taskId: "t1", occurrenceId: "o2" },
    })
    expect(twice.map((b) => b.ref)).toEqual(["d.o.o2", "c.o.o2.keep"])
  })
})

describe("a press, end to end", () => {
  async function setup() {
    const store = new MemoryStore()
    const clock = new FakeClock(new Date(T0))
    const notifier = new FakeNotifier()
    const lanes = new Lanes({ store, clock, notifier, types: { reminder } })
    const folks = await people(store)
    const { task } = await createTask(
      store,
      actor(folks.larry),
      folks.larry,
      {
        type: reminder,
        title: "dentist",
        config: { text: "dentist" },
        schedule: { kind: "once", at: "2026-03-02T14:00:00.000Z" },
      },
      clock.now(),
    )
    return { store, clock, notifier, lanes, task, ...folks }
  }

  it("gives the owner done and snooze, a recipient only the opt-out; done routes back once", async () => {
    const { store, clock, notifier, lanes, task, larry, moe, curly } = await setup()
    await invite(store, actor(larry), task, moe.id, clock.now())
    await respondToInvite(store, task, moe.id, "accept", clock.now())
    clock.set("2026-03-02T14:00:30.000Z")
    await lanes.tickNotify()

    const [toLarry, toMoe] = notifier.sent
    expect(toLarry?.userId).toBe(larry.id)
    expect(toLarry?.message.actions).toEqual(["done", "snooze"])
    expect(toMoe?.message.actions).toEqual(["opt_out"])
    const done = replyButtons(toLarry?.message ?? { text: "" })[0]?.ref ?? ""

    expect(await replyForRef(store, done, curly.id)).toEqual({
      ok: false,
      error: "That button is not yours to press any more.",
    })
    // Moe receives only: the owner's Done is not his to press (plan 1.1).
    expect((await replyForRef(store, done, moe.id)).ok).toBe(false)
    const pressed = await replyForRef(store, done, larry.id)
    if (!pressed.ok) throw new Error(pressed.error)
    expect(pressed.input).toMatchObject({ taskId: task.id, userId: larry.id, kind: "done" })
    expect(await lanes.reply(pressed.input)).toEqual({ summary: "done" })
    expect((await store.listReplies(task.id)).map((r) => r.kind)).toEqual(["accept", "done"])
    expect(await replyForRef(store, done, larry.id)).toEqual({
      ok: false,
      error: "That run has already been answered.",
    })
  })

  it("refuses a second snooze, a stale run and a finished task", async () => {
    const { store, clock, notifier, lanes, task, larry } = await setup()
    clock.set("2026-03-02T14:00:30.000Z")
    await lanes.tickNotify()
    const [snooze, done] = ["snooze", "done"].map(
      (kind) =>
        replyButtons(notifier.sent[0]?.message ?? { text: "" }).find((b) => b.kind === kind)?.ref ??
        "",
    )
    const pressed = await replyForRef(store, snooze ?? "", larry.id)
    if (!pressed.ok) throw new Error(pressed.error)
    await lanes.reply(pressed.input)
    // The run is snoozed: a double tap, or its Done, is refused and queues nothing more.
    for (const ref of [snooze, done]) {
      expect(await replyForRef(store, ref ?? "", larry.id)).toEqual({
        ok: false,
        error: "That run is over; answer the latest message instead.",
      })
    }
    expect((await store.listOccurrences({ taskId: task.id, status: "queued" })).length).toBe(1)

    // A delivered run of a task that has since finished cannot be answered either.
    clock.set("2026-03-02T15:00:30.000Z")
    await lanes.tickNotify()
    const latest = replyButtons(notifier.sent[1]?.message ?? { text: "" })[1]?.ref ?? ""
    await store.updateTask(task.id, { status: "done", at: clock.now().toISOString() })
    expect((await replyForRef(store, latest, larry.id)).ok).toBe(false)
  })

  it("refuses a run button scoped to a task, and a reference too long for Discord", async () => {
    const { store, task, larry } = await setup()
    expect((await replyForRef(store, `d.t.${task.id}`, larry.id)).ok).toBe(false)
    const choice = "x".repeat(100)
    expect(() =>
      encodeReplyRef({ taskId: "t", occurrenceId: "o", kind: "decision", choice }),
    ).toThrow(/over 100/)
  })

  it("routes an invitation's accept, and only for the person invited, once", async () => {
    const { store, clock, lanes, task, larry, moe } = await setup()
    await invite(store, actor(larry), task, moe.id, clock.now())
    const accept = encodeReplyRef({ taskId: task.id, occurrenceId: null, kind: "accept" })
    expect((await replyForRef(store, accept, larry.id)).ok).toBe(false)
    const pressed = await replyForRef(store, accept, moe.id)
    if (!pressed.ok) throw new Error(pressed.error)
    await lanes.reply(pressed.input)
    expect((await store.listRecipients(task.id))[0]?.state).toBe("accepted")
    expect((await replyForRef(store, accept, moe.id)).ok).toBe(false)
  })

  it("says so when the run or task is gone", async () => {
    const { store, larry } = await setup()
    expect(await replyForRef(store, "d.o.nope", larry.id)).toEqual({
      ok: false,
      error: "That run no longer exists.",
    })
    expect((await replyForRef(store, "a.t.nope", larry.id)).ok).toBe(false)
    expect((await replyForRef(store, "garbage", larry.id)).ok).toBe(false)
  })
})
