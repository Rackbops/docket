import type { Store } from "./ports.js"

/**
 * The Store port's semantics as runnable cases (plan section 5.2): what `MemoryStore` does and
 * every host adapter must do too. A host runs each case against a fresh store of its own --
 *
 *   for (const c of STORE_CONTRACT) it(c.name, async () => c.run(await freshSqliteStore()))
 *
 * -- and a case throws `StoreContractError` naming what differed. No test framework is
 * imported, so any runner works and the package keeps no test dependency.
 */

export class StoreContractError extends Error {
  override name = "StoreContractError"
}

export interface StoreContractCase {
  name: string
  run(store: Store): Promise<void>
}

const AT = "2026-03-02T12:00:00.000Z"
const MID = "2026-03-02T12:30:00.000Z"
const LATER = "2026-03-02T13:00:00.000Z"

function check(ok: boolean, what: string): asserts ok {
  if (!ok) throw new StoreContractError(what)
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(a === e, `${what}: expected ${e}, got ${a}`)
}

async function owner(store: Store) {
  return store.createUser({ discordId: "d1", displayName: "Larry", at: AT })
}

async function task(store: Store, ownerId: string, title = "t") {
  return store.createTask({
    ownerId,
    type: "reminder",
    title,
    config: { text: title },
    schedule: null,
    lane: "notify",
    capabilities: ["notify"],
    at: AT,
  })
}

function occurrence(taskId: string, dueAt: string, dedupeKey: string, lane = "notify" as const) {
  return { taskId, lane, dueAt, dedupeKey, at: AT }
}

export const STORE_CONTRACT: readonly StoreContractCase[] = [
  {
    name: "ids fit a reply reference: none contains a dot",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const o = await store.createOccurrence(occurrence(t.id, AT, "k"))
      for (const [what, id] of [
        ["user", u.id],
        ["task", t.id],
        ["occurrence", o?.id ?? ""],
      ] as const) {
        check(id !== "" && !id.includes("."), `${what} id ${JSON.stringify(id)} has a dot`)
      }
    },
  },
  {
    name: "a user is created with defaults, found by Discord id, and patched",
    async run(store) {
      const u = await store.createUser({ discordId: "d9", at: AT })
      same(
        [u.displayName, u.timeZone, u.preferredHour, u.admin],
        [null, "UTC", 9, false],
        "user defaults",
      )
      same((await store.findUserByDiscordId("d9"))?.id, u.id, "found by Discord id")
      check((await store.findUserByDiscordId("nobody")) === null, "unknown Discord id is null")
      await store.updateUser(u.id, { timeZone: "America/New_York", admin: true })
      const found = await store.findUserByDiscordId("d9")
      same(
        [found?.id, found?.timeZone, found?.admin, found?.displayName],
        [u.id, "America/New_York", true, null],
        "patch",
      )
    },
  },
  {
    name: "a task starts active with null state, and a patch changes only what it names",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      same([t.status, t.state, t.createdAt, t.updatedAt], ["active", null, AT, AT], "new task")
      const next = await store.updateTask(t.id, { state: { n: 1 }, at: LATER })
      same([next.title, next.config, next.state], ["t", { text: "t" }, { n: 1 }], "patched task")
      same(next.updatedAt, LATER, "updatedAt follows the patch")
      same((await store.getTask(t.id))?.state, { n: 1 }, "state persisted")
    },
  },
  {
    name: "tasks filter by owner, status and type",
    async run(store) {
      const a = await owner(store)
      const b = await store.createUser({ discordId: "d2", at: AT })
      const t1 = await task(store, a.id, "one")
      await task(store, b.id, "two")
      await store.updateTask(t1.id, { status: "paused", at: LATER })
      same((await store.listTasks({ ownerId: a.id })).length, 1, "by owner")
      same((await store.listTasks({ status: "active" })).length, 1, "by status")
      same((await store.listTasks({ type: "reminder" })).length, 2, "by type")
      same((await store.listTasks({ type: "price" })).length, 0, "other type")
    },
  },
  {
    name: "reads return copies: changing a returned row changes nothing stored",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      ;(t.config as { text: string }).text = "mutated"
      const read = await store.getTask(t.id)
      if (read) (read.config as { text: string }).text = "mutated again"
      same((await store.getTask(t.id))?.config, { text: "t" }, "config unchanged")
    },
  },
  {
    name: "a recipient is one row per task and user, set and removed",
    async run(store) {
      const u = await owner(store)
      const r = await store.createUser({ discordId: "d2", at: AT })
      const t = await task(store, u.id)
      await store.setRecipient(t.id, r.id, "invited", AT)
      await store.setRecipient(t.id, r.id, "accepted", LATER)
      same(
        (await store.listRecipients(t.id)).map((x) => [x.userId, x.state, x.at]),
        [[r.id, "accepted", LATER]],
        "upserted recipient",
      )
      await store.removeRecipient(t.id, r.id)
      same((await store.listRecipients(t.id)).length, 0, "removed")
    },
  },
  {
    name: "blocks list per owner and recipient pair and are lifted in place",
    async run(store) {
      const u = await owner(store)
      const r = await store.createUser({ discordId: "d2", at: AT })
      const block = await store.createBlock({
        ownerId: u.id,
        recipientId: r.id,
        expiresAt: null,
        declineReplyId: null,
        at: AT,
      })
      same([block.liftedBy, block.liftedAt], [null, null], "new block")
      same(
        (await store.listBlocks(u.id, r.id)).map((b) => b.id),
        [block.id],
        "found by pair",
      )
      same((await store.listBlocks(r.id, u.id)).length, 0, "pair is directional")
      const lifted = await store.liftBlock(block.id, u.id, LATER)
      same([lifted.liftedBy, lifted.liftedAt], [u.id, LATER], "lifted")
      same((await store.getBlock(block.id))?.liftedAt, LATER, "lift persisted")
    },
  },
  {
    name: "creating an occurrence with a known dedupe key is a no-op returning null",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const first = await store.createOccurrence(occurrence(t.id, AT, "sched:x"))
      check(first !== null, "first create returns the row")
      same([first?.status, first?.late, first?.startedAt], ["queued", false, null], "new row")
      check((await store.createOccurrence(occurrence(t.id, LATER, "sched:x"))) === null, "dup")
      same((await store.listOccurrences({ taskId: t.id })).length, 1, "one row kept")
    },
  },
  {
    name: "occurrences list soonest first, dueBefore inclusive, filtered by task, lane, status",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const late = await store.createOccurrence(occurrence(t.id, LATER, "k2"))
      const early = await store.createOccurrence(occurrence(t.id, AT, "k1", "notify"))
      await store.createOccurrence({ ...occurrence(t.id, AT, "k3"), lane: "execute" })
      same(
        (await store.listOccurrences({ taskId: t.id, lane: "notify" })).map((o) => o.id),
        [early?.id, late?.id],
        "sorted by dueAt",
      )
      same((await store.listOccurrences({ dueBefore: AT })).length, 2, "dueBefore inclusive")
      const second = await store.createOccurrence({ ...occurrence(t.id, AT, "k4"), at: LATER })
      const first = await store.createOccurrence({ ...occurrence(t.id, AT, "k5"), at: MID })
      same(
        (await store.listOccurrences({ taskId: t.id, lane: "notify", dueBefore: AT })).map(
          (o) => o.id,
        ),
        [early?.id, first?.id, second?.id],
        "same dueAt: by creation",
      )
      await store.updateOccurrence(early?.id ?? "", { status: "done", summary: "ok" })
      same((await store.listOccurrences({ status: "queued" })).length, 4, "by status")
      same((await store.getOccurrence(early?.id ?? ""))?.summary, "ok", "patched")
    },
  },
  {
    name: "deleting an occurrence takes only a queued one; requeueRunning honours the lane",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const a = await store.createOccurrence(occurrence(t.id, AT, "a"))
      const b = await store.createOccurrence(occurrence(t.id, AT, "b"))
      const c = await store.createOccurrence({ ...occurrence(t.id, AT, "c"), lane: "execute" })
      await store.createOccurrence(occurrence(t.id, LATER, "d"))
      await store.updateOccurrence(a?.id ?? "", { status: "running" })
      await store.updateOccurrence(c?.id ?? "", { status: "running" })
      await store.updateOccurrence(b?.id ?? "", { status: "done" })
      same(await store.requeueRunning("execute"), [c?.id], "only the execute lane requeued")
      same(await store.deleteOccurrence(b?.id ?? ""), false, "a done row is not deleted")
      same(await store.deleteOccurrence(a?.id ?? ""), false, "a running row is not deleted")
      same(await store.deleteOccurrence(c?.id ?? ""), true, "a requeued row is deleted")
      same(await store.deleteOccurrence(c?.id ?? ""), false, "a second delete finds nothing")
      check((await store.getOccurrence(c?.id ?? "")) === null, "deleted")
      same(
        (await store.listOccurrences({ taskId: t.id })).map((o) => o.status).sort(),
        ["done", "queued", "running"],
        "the rest remain",
      )
    },
  },
  {
    name: "events append in order and page after a cursor",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const o = await store.createOccurrence(occurrence(t.id, AT, "k"))
      const id = o?.id ?? ""
      const e1 = await store.addEvent({
        occurrenceId: id,
        agent: "docket",
        type: "status",
        text: "1",
        at: AT,
      })
      await store.addEvent({ occurrenceId: id, agent: "docket", type: "text", text: "2", at: AT })
      same(
        (await store.listEvents(id)).map((e) => e.text),
        ["1", "2"],
        "in order",
      )
      same(
        (await store.listEvents(id, e1.id)).map((e) => e.text),
        ["2"],
        "after the cursor",
      )
    },
  },
  {
    name: "task events and replies keep their order and payloads",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      await store.addTaskEvent({ taskId: t.id, actorId: u.id, kind: "created", detail: "", at: AT })
      await store.addTaskEvent({
        taskId: t.id,
        actorId: null,
        kind: "paused",
        detail: "",
        at: LATER,
      })
      same(
        (await store.listTaskEvents(t.id)).map((e) => e.kind),
        ["created", "paused"],
        "history",
      )
      const payload = { until: LATER, nested: [1, 2] }
      await store.addReply({
        occurrenceId: null,
        taskId: t.id,
        userId: u.id,
        kind: "snooze",
        payload,
        at: AT,
      })
      await store.addReply({
        occurrenceId: null,
        taskId: t.id,
        userId: u.id,
        kind: "done",
        payload: null,
        at: LATER,
      })
      const replies = await store.listReplies(t.id)
      same(
        replies.map((r) => r.kind),
        ["snooze", "done"],
        "replies in order",
      )
      same(replies[0]?.payload, payload, "payload round-trips")
    },
  },
  {
    name: "series points list oldest first; since is inclusive; limit keeps the newest",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      for (const [at, value] of [
        [LATER, 2],
        [AT, 1],
        ["2026-03-02T14:00:00.000Z", 3],
      ] as const) {
        await store.addSeriesPoint({ taskId: t.id, at, value })
      }
      same(
        (await store.listSeries(t.id)).map((p) => p.value),
        [1, 2, 3],
        "oldest first",
      )
      same(
        (await store.listSeries(t.id, { since: LATER })).map((p) => p.value),
        [2, 3],
        "since",
      )
      same(
        (await store.listSeries(t.id, { limit: 2 })).map((p) => p.value),
        [2, 3],
        "limit",
      )
      same((await store.listSeries(t.id))[0]?.unit, null, "unit defaults to null")
    },
  },
  {
    name: "users list in creation order and filter on admin",
    async run(store) {
      const a = await store.createUser({ discordId: "d1", at: AT })
      const b = await store.createUser({ discordId: "d2", admin: true, at: AT })
      const c = await store.createUser({ discordId: "d3", at: AT })
      same(
        (await store.listUsers()).map((u) => u.id),
        [a.id, b.id, c.id],
        "every user",
      )
      same(
        (await store.listUsers({ admin: true })).map((u) => u.id),
        [b.id],
        "admins",
      )
      same(
        (await store.listUsers({ admin: false })).map((u) => u.id),
        [a.id, c.id],
        "non-admins",
      )
    },
  },
  {
    name: "usage lists oldest first; since is inclusive, before exclusive; filters on user",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const v = await store.createUser({ discordId: "d2", at: AT })
      for (const [userId, at, calls] of [
        [u.id, LATER, 2],
        [u.id, AT, 1],
        [v.id, MID, 5],
      ] as const) {
        await store.addUsage({
          userId,
          taskId: userId === u.id ? t.id : null,
          occurrenceId: null,
          source: "run",
          calls,
          costUsd: 0.5,
          at,
        })
      }
      same(
        (await store.listUsage()).map((c) => c.calls),
        [1, 5, 2],
        "oldest first",
      )
      same(
        (await store.listUsage({ userId: u.id })).map((c) => c.calls),
        [1, 2],
        "one user",
      )
      same(
        (await store.listUsage({ since: MID, before: LATER })).map((c) => c.calls),
        [5],
        "since inclusive, before exclusive",
      )
      const [first] = await store.listUsage({ userId: u.id })
      same(
        [first?.source, first?.costUsd, first?.occurrenceId, first?.taskId],
        ["run", 0.5, null, t.id],
        "fields",
      )
    },
  },
  {
    name: "a notice key is claimed once",
    async run(store) {
      same(await store.claimNotice("budget:u1:2026-03-02", AT), true, "first claim")
      same(await store.claimNotice("budget:u1:2026-03-02", LATER), false, "second claim")
      same(await store.claimNotice("budget:u2:2026-03-02", LATER), true, "another key")
    },
  },
  {
    name: "a delivery is planned once, claimed only while owed, and settled as told",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const id = (await store.createOccurrence(occurrence(t.id, AT, "k")))?.id ?? ""
      same(await store.claimDelivery(id, u.id, AT), null, "nothing planned: no claim")
      const planned = await store.planDelivery(id, u.id, AT)
      same(
        [
          planned?.status,
          planned?.attempts,
          planned?.deferrals,
          planned?.retryAt,
          planned?.claimedAt,
        ],
        ["pending", 0, 0, AT, null],
        "planned row",
      )
      same(await store.planDelivery(id, u.id, LATER), null, "planning twice is a no-op")
      const claim = await store.claimDelivery(id, u.id, MID)
      same([claim?.status, claim?.retryAt, claim?.claimedAt], ["claimed", null, MID], "claimed")
      same(await store.claimDelivery(id, u.id, MID), null, "a held claim is not taken again")
      await store.settleDelivery(id, u.id, {
        status: "failed",
        error: "closed",
        attempts: 1,
        deferrals: 2,
        retryAt: LATER,
        at: MID,
      })
      const again = await store.claimDelivery(id, u.id, LATER)
      same(
        [again?.status, again?.attempts, again?.deferrals, again?.error, again?.retryAt],
        ["claimed", 1, 2, "closed", null],
        "an owed failure taken again, its counts kept",
      )
      const sent = await store.settleDelivery(id, u.id, {
        status: "sent",
        messageId: "m1",
        attempts: 1,
        deferrals: 2,
        retryAt: null,
        at: LATER,
      })
      same(
        [sent.status, sent.messageId, sent.error, sent.settledAt, sent.retryAt],
        ["sent", "m1", null, LATER, null],
        "sent, and an absent error cleared",
      )
      same(await store.claimDelivery(id, u.id, LATER), null, "a final row is never claimed")
    },
  },
  {
    // The Store must make the claim atomic -- one guarded write (`UPDATE ... WHERE retryAt IS NOT
    // NULL`), never a read then a write. This case can pass on a Store that reads then writes
    // when its two calls happen not to interleave, so it is a floor, not a proof.
    name: "two claims at once: exactly one wins",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const id = (await store.createOccurrence(occurrence(t.id, AT, "k")))?.id ?? ""
      await store.planDelivery(id, u.id, AT)
      const both = await Promise.all([
        store.claimDelivery(id, u.id, AT),
        store.claimDelivery(id, u.id, AT),
      ])
      same(both.filter((c) => c !== null).length, 1, "one claim")
    },
  },
  {
    name: "deliveries planned at the same instant list in the order they were planned",
    async run(store) {
      const a = await owner(store)
      const b = await store.createUser({ discordId: "d2", at: AT })
      const c = await store.createUser({ discordId: "d3", at: AT })
      const t = await task(store, a.id)
      const id = (await store.createOccurrence(occurrence(t.id, AT, "k")))?.id ?? ""
      // Not in id order, so a Store that sorts by user id instead fails.
      for (const u of [c, a, b]) await store.planDelivery(id, u.id, AT)
      same(
        (await store.listDeliveries({ occurrenceId: id })).map((d) => d.userId),
        [c.id, a.id, b.id],
        "ties on createdAt keep insertion order (the owner's copy is planned, and sent, first)",
      )
    },
  },
  {
    name: "deliveries list by run, person, status and due time, oldest first; forget-me deletes",
    async run(store) {
      const u = await owner(store)
      const v = await store.createUser({ discordId: "d2", at: AT })
      const t = await task(store, u.id)
      const o1 = (await store.createOccurrence(occurrence(t.id, AT, "k1")))?.id ?? ""
      const o2 = (await store.createOccurrence(occurrence(t.id, AT, "k2")))?.id ?? ""
      await store.planDelivery(o1, u.id, AT)
      await store.planDelivery(o1, v.id, MID)
      await store.planDelivery(o2, v.id, LATER)
      await store.claimDelivery(o1, u.id, MID)
      same(
        (await store.listDeliveries({ occurrenceId: o1 })).map((d) => d.userId),
        [u.id, v.id],
        "one run, oldest first",
      )
      same(
        (await store.listDeliveries({ userId: v.id })).map((d) => d.occurrenceId),
        [o1, o2],
        "one person",
      )
      same(
        (await store.listDeliveries({ status: "claimed" })).map((d) => d.userId),
        [u.id],
        "by status",
      )
      same(
        (await store.listDeliveries({ dueBefore: MID })).map((d) => [d.occurrenceId, d.userId]),
        [[o1, v.id]],
        "owed and due, inclusive; a claimed row is not owed",
      )
      same(await store.deleteDeliveries(v.id), 2, "forget-me deletes that person's rows")
      same(
        (await store.listDeliveries()).map((d) => d.userId),
        [u.id],
        "the rest remain",
      )
      let threw = false
      try {
        await store.settleDelivery(o2, v.id, {
          status: "sent",
          attempts: 0,
          deferrals: 0,
          retryAt: null,
          at: LATER,
        })
      } catch {
        threw = true
      }
      check(threw, "settling a row that does not exist throws")
    },
  },
  {
    name: "a conditional update applies only to the expected status; a record round-trips",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const o = await store.createOccurrence(occurrence(t.id, AT, "k"))
      const id = o?.id ?? ""
      same(o?.record, null, "no record at first")
      const started = await store.updateOccurrenceIf(id, "queued", {
        status: "running",
        startedAt: MID,
      })
      same([started?.status, started?.startedAt], ["running", MID], "applied")
      same(
        await store.updateOccurrenceIf(id, "queued", { status: "running" }),
        null,
        "not queued: nothing applied",
      )
      same(await store.updateOccurrenceIf("nope", "queued", { status: "running" }), null, "no row")
      const record = {
        outcome: { notify: { text: "hi", actions: ["done" as const] }, state: { n: 1 } },
        costUsd: null,
        firedAt: MID,
        appliedAt: null,
        resumes: 0,
      }
      await store.updateOccurrence(id, { record })
      same((await store.getOccurrence(id))?.record, record, "record round-trips")
      same(
        (await store.requeueRunning()).length === 1 &&
          (await store.getOccurrence(id))?.startedAt === null,
        true,
        "requeueRunning puts a run back unstarted",
      )
      same((await store.getOccurrence(id))?.record, record, "and keeps its record")
    },
  },
  {
    name: "a series point with a stored key is not added again",
    async run(store) {
      const u = await owner(store)
      const t = await task(store, u.id)
      const first = await store.addSeriesPoint({ taskId: t.id, at: AT, value: 1, key: "o1:0" })
      const again = await store.addSeriesPoint({ taskId: t.id, at: LATER, value: 2, key: "o1:0" })
      await store.addSeriesPoint({ taskId: t.id, at: AT, value: 3 })
      await store.addSeriesPoint({ taskId: t.id, at: AT, value: 4 })
      same([first.key, again.id, again.value], ["o1:0", first.id, 1], "the stored point returned")
      same(
        (await store.listSeries(t.id)).map((p) => [p.value, p.key]),
        [
          [1, "o1:0"],
          [3, null],
          [4, null],
        ],
        "keyless points are always added",
      )
    },
  },
  {
    name: "findings list oldest first by task, owner and since; a stored key is not added again",
    async run(store) {
      const u = await owner(store)
      const v = await store.createUser({ discordId: "d2", at: AT })
      const t = await task(store, u.id, "mine")
      const w = await task(store, v.id, "theirs")
      const first = await store.addFinding({
        taskId: t.id,
        ownerId: u.id,
        occurrenceId: "o1",
        key: "o1:0",
        type: "research",
        text: "claim one",
        tags: ["research", "approve"],
        source: "https://example.org/a",
        at: LATER,
      })
      same(
        [first.key, first.type, first.tags, first.source, first.occurrenceId],
        ["o1:0", "research", ["research", "approve"], "https://example.org/a", "o1"],
        "fields",
      )
      const again = await store.addFinding({
        taskId: t.id,
        ownerId: u.id,
        occurrenceId: "o1",
        key: "o1:0",
        type: "research",
        text: "claim one, applied again",
        at: LATER,
      })
      same([again.id, again.text], [first.id, "claim one"], "the stored finding returned")
      const bare = await store.addFinding({
        taskId: t.id,
        ownerId: u.id,
        occurrenceId: null,
        type: "research",
        text: "earlier",
        at: AT,
      })
      same([bare.key, bare.tags, bare.source], [null, [], null], "defaults")
      await store.addFinding({
        taskId: w.id,
        ownerId: v.id,
        occurrenceId: null,
        type: "research",
        text: "other owner",
        at: MID,
      })
      same(
        (await store.listFindings({ taskId: t.id })).map((f) => f.text),
        ["earlier", "claim one"],
        "one task, oldest first",
      )
      same(
        (await store.listFindings()).map((f) => f.text),
        ["earlier", "other owner", "claim one"],
        "every finding",
      )
      same(
        (await store.listFindings({ ownerId: v.id })).map((f) => f.text),
        ["other owner"],
        "one owner",
      )
      same(
        (await store.listFindings({ since: MID })).map((f) => f.text),
        ["other owner", "claim one"],
        "since is inclusive",
      )
    },
  },
  {
    name: "findings at the same instant list in insertion order; forget-me deletes an owner's",
    async run(store) {
      const u = await owner(store)
      const v = await store.createUser({ discordId: "d2", at: AT })
      const t = await task(store, u.id)
      const w = await task(store, v.id)
      for (const text of ["b", "a", "c"]) {
        await store.addFinding({
          taskId: t.id,
          ownerId: u.id,
          occurrenceId: null,
          type: "research",
          text,
          at: AT,
        })
      }
      await store.addFinding({
        taskId: w.id,
        ownerId: v.id,
        occurrenceId: null,
        type: "research",
        text: "kept",
        at: AT,
      })
      same(
        (await store.listFindings({ taskId: t.id })).map((f) => f.text),
        ["b", "a", "c"],
        "ties keep insertion order, not text order",
      )
      same(await store.deleteFindings(u.id), 3, "forget-me deletes that owner's findings")
      same(await store.deleteFindings(u.id), 0, "a second delete finds nothing")
      same(
        (await store.listFindings()).map((f) => f.text),
        ["kept"],
        "the rest remain",
      )
    },
  },
]
