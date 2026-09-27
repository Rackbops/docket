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
    name: "a user is created with defaults and found by Discord id and usr subject",
    async run(store) {
      const u = await store.createUser({ discordId: "d9", at: AT })
      same(
        [u.usrSubject, u.displayName, u.timeZone, u.preferredHour, u.admin],
        [null, null, "UTC", 9, false],
        "user defaults",
      )
      same((await store.findUserByDiscordId("d9"))?.id, u.id, "found by Discord id")
      check((await store.findUserBySubject("nobody")) === null, "unknown subject is null")
      await store.updateUser(u.id, { usrSubject: "uuid-1", timeZone: "America/New_York" })
      const found = await store.findUserBySubject("uuid-1")
      same(
        [found?.id, found?.timeZone, found?.discordId],
        [u.id, "America/New_York", "d9"],
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
      await store.updateOccurrence(early?.id ?? "", { status: "done", summary: "ok" })
      same((await store.listOccurrences({ status: "queued" })).length, 2, "by status")
      same((await store.getOccurrence(early?.id ?? ""))?.summary, "ok", "patched")
    },
  },
  {
    name: "deleting queued occurrences spares the rest; requeueRunning honours the lane",
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
      same(await store.deleteQueuedOccurrences(t.id), 2, "queued rows deleted")
      same(
        (await store.listOccurrences({ taskId: t.id })).map((o) => o.status).sort(),
        ["done", "running"],
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
      same((await store.listReplies(t.id))[0]?.payload, payload, "payload round-trips")
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
]
