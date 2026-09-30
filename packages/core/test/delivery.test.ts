import { describe, expect, it } from "vitest"

import {
  DEFAULT_DELIVERY_POLICY,
  deliver,
  ExecutorUnavailableError,
  STALE_CLAIM_MS,
  visibleDeliveries,
  visibleEvents,
  visibleOccurrences,
} from "../src/index.js"
import { actor, FakeNotifier, T0 } from "./helpers.js"
import { closed, flaky, setup } from "./run-helpers.js"

const MIN = 60_000

describe("delivery per recipient", () => {
  it("never lets one recipient who cannot be messaged block the others", async () => {
    const { lanes, notifier, share, larry, moe, curly } = await setup()
    await share(moe, curly)
    notifier.failFor.set(moe.id, closed)
    expect(await lanes.tickNotify()).toEqual({ ran: 1, failed: 0, skipped: 0 })
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, curly.id])
  })

  it("fails an unreachable recipient for good at once, so a pause counts runs, not ticks", async () => {
    const { store, clock, lanes, notifier, runId, share, larry, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, closed)
    await lanes.tickNotify()
    const id = await runId()
    const rows = await store.listDeliveries({ occurrenceId: id })
    expect(rows.map((d) => [d.userId, d.status, d.attempts, d.retryAt])).toEqual([
      [larry.id, "sent", 0, null],
      [moe.id, "failed", 1, null],
    ])
    expect(rows[1]?.error).toBe("recipient cannot be messaged")
    clock.advance(60 * MIN)
    await lanes.tickNotify()
    expect(notifier.attempts.filter((u) => u === moe.id)).toHaveLength(1)
  })

  it("retries a send that failed with nothing sent, with a backoff, exactly three times", async () => {
    const { store, clock, lanes, notifier, runs, runId, share, larry, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, flaky)
    await lanes.tickNotify()
    const id = await runId()
    const row = async () =>
      (await store.listDeliveries({ occurrenceId: id })).find((d) => d.userId === moe.id)
    expect([(await row())?.attempts, (await row())?.retryAt]).toEqual([
      1,
      new Date(Date.parse(T0) + MIN).toISOString(),
    ])
    // Before the backoff is up, nothing is tried.
    clock.advance(MIN - 1)
    await lanes.tickNotify()
    expect(notifier.attempts.filter((u) => u === moe.id)).toHaveLength(1)
    clock.advance(1)
    await lanes.tickNotify() // second attempt; the next waits two minutes
    expect((await row())?.retryAt).toBe(new Date(clock.now().getTime() + 2 * MIN).toISOString())
    clock.advance(2 * MIN)
    await lanes.tickNotify() // third and last
    expect([(await row())?.status, (await row())?.attempts, (await row())?.retryAt]).toEqual([
      "failed",
      3,
      null,
    ])
    // The retries were sends, never re-runs.
    expect(runs.n).toBe(1)
    clock.advance(60 * MIN)
    await lanes.tickNotify()
    expect(notifier.attempts.filter((u) => u === moe.id)).toHaveLength(3)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
  })

  it("defers without counting an attempt, backs off, and gives up after the deferral limit", async () => {
    const { store, clock, lanes, notifier, runId, share, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, () => new ExecutorUnavailableError("delivery to moe is paused"))
    await lanes.tickNotify()
    const id = await runId()
    const events = (await store.listEvents(id)).length
    const row = async () =>
      (await store.listDeliveries({ occurrenceId: id })).find((d) => d.userId === moe.id)
    expect([(await row())?.status, (await row())?.attempts, (await row())?.deferrals]).toEqual([
      "deferred",
      0,
      1,
    ])
    // Tick every minute for a day: each retry waits twice as long as the last, up to an hour.
    for (let i = 0; i < 24 * 60; i++) {
      clock.advance(MIN)
      await lanes.tickNotify()
    }
    const tries = notifier.attempts.filter((u) => u === moe.id).length
    expect(tries).toBe(DEFAULT_DELIVERY_POLICY.deferrals)
    expect([(await row())?.status, (await row())?.deferrals, (await row())?.retryAt]).toEqual([
      "failed",
      DEFAULT_DELIVERY_POLICY.deferrals,
      null,
    ])
    // Retries that did nothing new wrote nothing to the run's history.
    expect((await store.listEvents(id)).length).toBe(events)
  })

  it("sends a deferred copy once the host is ready", async () => {
    const { clock, lanes, notifier, runs, share, larry, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, () => new ExecutorUnavailableError("not now"))
    await lanes.tickNotify()
    notifier.failFor.clear()
    clock.advance(MIN)
    await lanes.tickNotify()
    expect(runs.n).toBe(1)
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id, moe.id])
  })

  it("never resends a send that may have gone out, or a claim a crash left behind", async () => {
    const { store, clock, lanes, notifier, runId, share, larry, moe, curly } = await setup()
    await share(moe, curly)
    notifier.failFor.set(moe.id, () => new Error("socket hang up"))
    notifier.failFor.set(curly.id, flaky)
    await lanes.tickNotify()
    const id = await runId()
    // Curly is owed a retry; a sender takes his claim and the process dies mid-send.
    notifier.failFor.clear()
    clock.advance(MIN)
    expect(await store.claimDelivery(id, curly.id, clock.now().toISOString())).not.toBeNull()
    await lanes.recover()
    await lanes.tickNotify()
    expect(notifier.sent.map((s) => s.userId)).toEqual([larry.id])
    expect(
      (await store.listDeliveries({ status: "unconfirmed" })).map((d) => [d.userId, d.error]),
    ).toEqual([
      [moe.id, "socket hang up"],
      [curly.id, "claimed, never settled"],
    ])
  })

  it("settles a claim left open past the stale limit as unconfirmed, without a restart", async () => {
    const { store, clock, lanes, notifier, runId, share, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, flaky)
    await lanes.tickNotify()
    const id = await runId()
    clock.advance(MIN)
    await store.claimDelivery(id, moe.id, clock.now().toISOString())
    clock.advance(STALE_CLAIM_MS - 1)
    await lanes.tickNotify()
    expect((await store.listDeliveries({ status: "claimed" })).length).toBe(1)
    clock.advance(2)
    await lanes.tickNotify()
    expect((await store.listDeliveries({ status: "unconfirmed" })).map((d) => d.userId)).toEqual([
      moe.id,
    ])
  })

  it("never sends on a claim another sender holds", async () => {
    const { store, clock, notifier, runId, share, lanes, task, larry, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, flaky)
    await lanes.tickNotify()
    const id = await runId()
    clock.advance(MIN)
    await store.claimDelivery(id, moe.id, clock.now().toISOString())
    const run = await store.getOccurrence(id)
    if (!run) throw new Error("no run")
    const fresh = new FakeNotifier()
    const report = await deliver(
      store,
      fresh,
      run,
      task.ownerId,
      new Map([
        [larry.id, larry],
        [moe.id, moe],
      ]),
      { text: "x" },
      { now: () => clock.now() },
    )
    expect(fresh.sent).toHaveLength(0)
    expect(report.untried).toEqual([])
    expect((await store.listDeliveries({ occurrenceId: id, status: "claimed" })).length).toBe(1)
  })

  it("reports an owed row whose claim another sender won between the read and the claim", async () => {
    const { store, clock, notifier, runId, share, lanes, task, larry, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, flaky)
    await lanes.tickNotify()
    const id = await runId()
    clock.advance(MIN)
    const run = await store.getOccurrence(id)
    if (!run) throw new Error("no run")
    // The race: the row is owed when listed, and someone claims it just before we do.
    const racing = Object.create(store) as typeof store
    racing.claimDelivery = async (o, u, at) => {
      await store.claimDelivery(o, u, at)
      return null
    }
    const fresh = new FakeNotifier()
    const report = await deliver(
      racing,
      fresh,
      run,
      task.ownerId,
      new Map([
        [larry.id, larry],
        [moe.id, moe],
      ]),
      { text: "x" },
      { now: () => clock.now() },
    )
    expect(fresh.sent).toHaveLength(0)
    expect(report.untried).toEqual([moe.id])
  })

  it("stops owing a copy to someone who opted out before it went out", async () => {
    const { store, clock, lanes, notifier, runId, share, task, moe } = await setup()
    await share(moe)
    notifier.failFor.set(moe.id, flaky)
    await lanes.tickNotify()
    await lanes.reply({
      taskId: task.id,
      occurrenceId: null,
      userId: moe.id,
      kind: "opt_out",
      payload: null,
    })
    notifier.failFor.clear()
    clock.advance(MIN)
    await lanes.tickNotify()
    expect(notifier.sent.map((s) => s.userId)).not.toContain(moe.id)
    const row = (await store.listDeliveries({ occurrenceId: await runId() }))[1]
    expect([row?.status, row?.error, row?.retryAt]).toEqual([
      "failed",
      "no longer a recipient",
      null,
    ])
  })
})

describe("what a recipient may read", () => {
  it("hides the run record, other people's deliveries and old delivered lines", async () => {
    const { store, lanes, notifier, runId, share, larry, moe, curly, task } = await setup()
    await share(moe, curly)
    notifier.failFor.set(curly.id, flaky)
    await lanes.tickNotify()
    const id = await runId()
    await store.addEvent({
      occurrenceId: id,
      agent: "notifier",
      type: "delivered",
      text: `${curly.id} m9`,
      at: T0,
    })
    const asMoe = actor(moe)
    expect((await visibleOccurrences(store, asMoe, task.id))?.[0]?.record).toBeNull()
    expect((await visibleOccurrences(store, actor(larry), task.id))?.[0]?.record).not.toBeNull()
    expect((await visibleDeliveries(store, asMoe, id))?.map((d) => d.userId)).toEqual([moe.id])
    expect((await visibleDeliveries(store, actor(larry), id))?.length).toBe(3)
    const lines = (await visibleEvents(store, asMoe, id)) ?? []
    expect(lines.map((e) => e.text).join("\n")).not.toContain(curly.id)
    expect(
      (await visibleEvents(store, actor(larry), id))?.some((e) => e.type === "delivered"),
    ).toBe(true)
  })
})
