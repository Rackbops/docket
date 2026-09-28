import { createTask, type PeriodSchedule, ReplyRefusedError } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"

import { decisionOf, renewal } from "../src/index.js"
import { actor, tracker } from "./helpers.js"

const yearly: PeriodSchedule = {
  kind: "period",
  every: 1,
  unit: "year",
  anchor: "2026-10-01",
  leadDays: 7,
}

async function netflix() {
  const t = await tracker()
  const { task } = await createTask(
    t.store,
    actor(t.owner),
    t.owner,
    {
      type: renewal,
      title: "Netflix",
      config: { amount: 15.99, currency: "USD", note: "Cancel under Account > Membership." },
      schedule: yearly,
    },
    t.clock.now(),
  )
  return { ...t, task }
}

async function decide(t: Awaited<ReturnType<typeof netflix>>, payload: unknown) {
  const [asked] = (await t.store.listOccurrences({ taskId: t.task.id })).filter(
    (o) => o.status === "done",
  )
  return t.lanes.reply({
    taskId: t.task.id,
    occurrenceId: asked?.id ?? null,
    userId: t.owner.id,
    kind: "decision",
    payload,
  })
}

describe("renewal", () => {
  it("arrives at lead time, records keep, and the next occurrence is one period later", async () => {
    const t = await netflix()
    const [first] = await t.store.listOccurrences({ taskId: t.task.id })
    expect(first?.dueAt).toBe("2026-09-24T13:00:00.000Z") // 7 days before, 09:00 EDT

    t.clock.set("2026-09-24T13:00:00.000Z")
    expect(await t.lanes.tickNotify()).toMatchObject({ ran: 1, failed: 0 })
    const [dm] = t.notifier.sent
    expect(dm?.message.text).toBe(
      "Netflix renews on 2026-10-01, in 7 days: 15.99 USD. Keep it, cancel it, or mark it renewed.\n" +
        "Cancel under Account > Membership.",
    )
    expect(dm?.message.actions).toEqual(["decision", "snooze"])
    expect(dm?.message.decisions).toEqual(["keep", "cancel", "renewed"])

    const outcome = await decide(t, { choice: "keep" })
    expect(outcome?.summary).toBe("keep for 2026-10-01 at 15.99 USD")
    const series = await t.store.listSeries(t.task.id)
    expect(series.map((p) => [p.value, p.unit, p.note])).toEqual([[15.99, "USD", "keep"]])
    expect((await t.store.getTask(t.task.id))?.state).toMatchObject({
      amount: 15.99,
      decision: "keep",
      periodDate: "2026-10-01",
    })

    const all = await t.store.listOccurrences({ taskId: t.task.id })
    expect(all.map((o) => [o.status, o.dueAt])).toEqual([
      ["done", "2026-09-24T13:00:00.000Z"],
      ["queued", "2027-09-24T13:00:00.000Z"],
    ])

    // A year on, the reminder carries what it has cost so far and the last decision.
    t.clock.set("2027-09-24T13:00:00.000Z")
    await t.lanes.tickNotify()
    expect(t.notifier.sent[1]?.message.text.split("\n").slice(2)).toEqual([
      "So far: 1 period, 15.99 USD.",
      "Last time (2026-10-01): keep.",
    ])
  })

  it("ends the task on cancel", async () => {
    const t = await netflix()
    t.clock.set("2026-09-24T13:00:00.000Z")
    await t.lanes.tickNotify()
    const outcome = await decide(t, "cancel")
    expect(outcome?.complete).toBe(true)
    expect((await t.store.getTask(t.task.id))?.status).toBe("done")
    expect((await t.store.listOccurrences({ taskId: t.task.id })).map((o) => o.status)).toEqual([
      "done",
    ])
    expect(await t.store.listSeries(t.task.id)).toEqual([])
  })

  it("takes a new amount with renewed and asks with it next time", async () => {
    const t = await netflix()
    t.clock.set("2026-09-24T13:00:00.000Z")
    await t.lanes.tickNotify()
    await decide(t, { choice: "renewed", amount: 17.99 })
    expect((await t.store.listSeries(t.task.id)).map((p) => [p.value, p.note])).toEqual([
      [17.99, "renewed"],
    ])
    t.clock.set("2027-09-24T13:00:00.000Z")
    await t.lanes.tickNotify()
    expect(t.notifier.sent[1]?.message.text).toContain("in 7 days: 17.99 USD.")
  })

  it("snoozes like a reminder, and decides on the snooze's run for the original period", async () => {
    const t = await netflix()
    t.clock.set("2026-09-24T13:00:00.000Z")
    await t.lanes.tickNotify()
    const [asked] = await t.store.listOccurrences({ taskId: t.task.id })
    const snoozed = await t.lanes.reply({
      taskId: t.task.id,
      occurrenceId: asked?.id ?? null,
      userId: t.owner.id,
      kind: "snooze",
      payload: { minutes: 2 * 24 * 60 },
    })
    expect(snoozed?.snoozeUntil?.toISOString()).toBe("2026-09-26T13:00:00.000Z")
    // The snoozed run is answered; its decision arrives on the run the snooze queued.
    const again = { taskId: t.task.id, userId: t.owner.id, kind: "decision" as const }
    await expect(
      t.lanes.reply({ ...again, occurrenceId: asked?.id ?? null, payload: { choice: "keep" } }),
    ).rejects.toThrow(ReplyRefusedError)
    t.clock.set("2026-09-26T13:00:00.000Z")
    await t.lanes.tickNotify()
    // Two days later, still about the 2026-10-01 renewal, not 2026-10-03.
    expect(t.notifier.sent[1]?.message.text).toMatch(/^Netflix renews on 2026-10-01, in 5 days/)
    const later = (await t.store.listOccurrences({ taskId: t.task.id })).find(
      (o) => o.dueAt === "2026-09-26T13:00:00.000Z",
    )
    const kept = await t.lanes.reply({
      ...again,
      occurrenceId: later?.id ?? null,
      payload: { choice: "keep" },
    })
    expect(kept?.summary).toBe("keep for 2026-10-01 at 15.99 USD")
  })

  it("shrugs at a decision it does not know", async () => {
    const t = await netflix()
    t.clock.set("2026-09-24T13:00:00.000Z")
    await t.lanes.tickNotify()
    const [asked] = await t.store.listOccurrences({ taskId: t.task.id })
    const unknown = await t.lanes.reply({
      taskId: t.task.id,
      occurrenceId: asked?.id ?? null,
      userId: t.owner.id,
      kind: "decision",
      payload: { choice: "maybe" },
    })
    expect(unknown?.summary).toMatch(/not understood/)
    expect(await t.store.listSeries(t.task.id)).toEqual([])
  })

  it("serves a one-off expiry on a once schedule, dated by the owner's day", async () => {
    const t = await tracker()
    await createTask(
      t.store,
      actor(t.owner),
      t.owner,
      {
        type: renewal,
        title: "Laptop warranty",
        config: { amount: 0, currency: "USD" },
        schedule: { kind: "once", at: "2026-06-01T13:00:00.000Z" },
      },
      t.clock.now(),
    )
    t.clock.set("2026-06-01T13:00:00.000Z")
    await t.lanes.tickNotify()
    expect(t.notifier.sent[0]?.message.text).toMatch(
      /^Laptop warranty renews today, 2026-06-01: 0.00 USD\./,
    )
  })

  it("reads a decision from a word or an object", () => {
    expect(decisionOf("keep")).toEqual({ choice: "keep", amount: null })
    expect(decisionOf({ choice: "renewed", amount: 12 })).toEqual({ choice: "renewed", amount: 12 })
    expect(decisionOf({ choice: "renewed", amount: -1 })).toEqual({
      choice: "renewed",
      amount: null,
    })
    expect(decisionOf(42)).toEqual({ choice: null, amount: null })
  })
})
