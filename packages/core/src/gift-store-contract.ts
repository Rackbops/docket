import type { GiftFieldsByKind } from "./gift-model.js"
import {
  GiftDuplicateError,
  GiftIdempotencyError,
  GiftNotFoundError,
  GiftRevisionError,
  type GiftStore,
  type GiftWriteMeta,
} from "./gift-ports.js"

/**
 * The GiftStore port's semantics as runnable cases (plan item 158), in the shape of
 * `STORE_CONTRACT`: a host runs each case against a fresh store of its own --
 *
 *   for (const c of GIFT_STORE_CONTRACT) it(c.name, async () => c.run(await freshGiftStore()))
 *
 * -- and a case throws `GiftStoreContractError` naming what differed. No test framework is
 * imported. Fixtures are synthetic.
 */

export class GiftStoreContractError extends Error {
  override name = "GiftStoreContractError"
}

export interface GiftStoreContractCase {
  name: string
  run(store: GiftStore): Promise<void>
}

const AT = "2026-11-01T12:00:00.000Z"
const LATER = "2026-11-02T12:00:00.000Z"
const A = "owner-a"
const B = "owner-b"

function check(ok: boolean, what: string): asserts ok {
  if (!ok) throw new GiftStoreContractError(what)
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(a === e, `${what}: expected ${e}, got ${a}`)
}

async function refuses(
  work: () => Promise<unknown>,
  kind: abstract new (...args: never[]) => Error,
  what: string,
): Promise<void> {
  try {
    await work()
  } catch (e) {
    check(e instanceof kind, `${what}: threw ${(e as Error)?.name ?? e}, not ${kind.name}`)
    return
  }
  throw new GiftStoreContractError(`${what}: did not throw ${kind.name}`)
}

function meta(ownerId = A, extra: Partial<GiftWriteMeta> = {}): GiftWriteMeta {
  return { ownerId, actor: ownerId, source: "api", at: AT, ...extra }
}

function person(name = "Aunt Example"): GiftFieldsByKind["recipient"] {
  return {
    displayName: name,
    kind: "person",
    memberIds: [],
    labels: [],
    interests: [],
    avoid: [],
    notes: null,
  }
}

function occasion(): GiftFieldsByKind["occasion"] {
  return {
    kind: "christmas",
    title: "Christmas 2026",
    date: "2026-12-25",
    timeZone: null,
    year: 2026,
    currency: "USD",
    budgetMinor: null,
  }
}

function pair(occasionId: string, recipientId: string): GiftFieldsByKind["occasionRecipient"] {
  return {
    occasionId,
    recipientId,
    target: null,
    budgetMinor: null,
    decision: "planning",
    skipReason: null,
  }
}

function item(title = "Board game"): GiftFieldsByKind["item"] {
  return {
    title,
    url: null,
    productKey: null,
    variant: null,
    notes: null,
    source: { kind: "manual", ref: null },
    planning: "idea",
    estimateMinor: null,
    currency: null,
  }
}

export const GIFT_STORE_CONTRACT: readonly GiftStoreContractCase[] = [
  {
    name: "gift: a record starts at revision 1, unarchived, and its ids carry no dot",
    async run(store) {
      const r = await store.create("recipient", meta(), person())
      same(
        [r.revision, r.archived, r.ownerId, r.createdAt, r.updatedAt],
        [1, false, A, AT, AT],
        "new",
      )
      same(r.displayName, "Aunt Example", "fields kept")
      check(r.id !== "" && !r.id.includes("."), `id ${JSON.stringify(r.id)} is empty or has a dot`)
      same((await store.get("recipient", A, r.id))?.id, r.id, "read back")
    },
  },
  {
    name: "gift: an update at the current revision bumps it and changes only what it names",
    async run(store) {
      const r = await store.create("recipient", meta(), person())
      const next = await store.update("recipient", r.id, meta(A, { at: LATER }), 1, {
        notes: "likes puzzles",
      })
      same(
        [next.revision, next.notes, next.displayName],
        [2, "likes puzzles", "Aunt Example"],
        "patched",
      )
      same([next.createdAt, next.updatedAt], [AT, LATER], "times")
      same((await store.get("recipient", A, r.id))?.revision, 2, "persisted")
    },
  },
  {
    name: "gift: a stale revision is refused and changes nothing",
    async run(store) {
      const r = await store.create("recipient", meta(), person())
      await store.update("recipient", r.id, meta(), 1, { notes: "first" })
      await refuses(
        () => store.update("recipient", r.id, meta(), 1, { notes: "stale" }),
        GiftRevisionError,
        "stale revision",
      )
      const now = await store.get("recipient", A, r.id)
      same([now?.revision, now?.notes], [2, "first"], "unchanged after a stale write")
    },
  },
  {
    name: "gift: two updates read at one revision, sent at once: exactly one wins",
    async run(store) {
      const r = await store.create("recipient", meta(), person())
      const results = await Promise.allSettled([
        store.update("recipient", r.id, meta(), 1, { notes: "one" }),
        store.update("recipient", r.id, meta(), 1, { notes: "two" }),
      ])
      same(results.filter((x) => x.status === "fulfilled").length, 1, "winners")
      const loser = results.find((x) => x.status === "rejected") as PromiseRejectedResult
      check(loser.reason instanceof GiftRevisionError, "the loser is a revision refusal")
      same((await store.get("recipient", A, r.id))?.revision, 2, "one bump")
    },
  },
  {
    name: "gift: another owner's record reads as missing and cannot be changed",
    async run(store) {
      const r = await store.create("recipient", meta(A), person())
      check((await store.get("recipient", B, r.id)) === null, "get as another owner is null")
      same((await store.list("recipient", B)).length, 0, "list as another owner is empty")
      await refuses(
        () => store.update("recipient", r.id, meta(B), 1, { notes: "mine now" }),
        GiftNotFoundError,
        "update as another owner",
      )
      same((await store.listEvents(B)).length, 0, "no events for the other owner")
      const now = await store.get("recipient", A, r.id)
      same([now?.revision, now?.notes], [1, null], "unchanged")
    },
  },
  {
    name: "gift: an id read as another kind is missing",
    async run(store) {
      const r = await store.create("recipient", meta(), person())
      check((await store.get("item", A, r.id)) === null, "a recipient id is no item")
      await refuses(
        () => store.update("item", r.id, meta(), 1, { title: "x" }),
        GiftNotFoundError,
        "update by the wrong kind",
      )
    },
  },
  {
    name: "gift: a replayed create with the same key returns the first record and writes nothing",
    async run(store) {
      const m = meta(A, { idempotencyKey: "k1" })
      const first = await store.create("item", m, item())
      const again = await store.create("item", m, item())
      same(again.id, first.id, "same record")
      same((await store.list("item", A)).length, 1, "one record")
      same((await store.listEvents(A)).length, 1, "one event")
    },
  },
  {
    name: "gift: a replayed update with the same key returns the first result and bumps once",
    async run(store) {
      const r = await store.create("item", meta(), item())
      const m = meta(A, { idempotencyKey: "u1" })
      const first = await store.update("item", r.id, m, 1, { planning: "selected" })
      const again = await store.update("item", r.id, m, 1, { planning: "selected" })
      same([first.revision, again.revision], [2, 2], "same result")
      same((await store.get("item", A, r.id))?.revision, 2, "one bump")
    },
  },
  {
    name: "gift: a key reused for another request is refused",
    async run(store) {
      const m = meta(A, { idempotencyKey: "k2" })
      await store.create("item", m, item("one"))
      await refuses(() => store.create("item", m, item("two")), GiftIdempotencyError, "reused key")
      same(
        (await store.list("item", A)).map((x) => x.title),
        ["one"],
        "nothing written",
      )
    },
  },
  {
    name: "gift: keys belong to one owner",
    async run(store) {
      const a = await store.create("item", meta(A, { idempotencyKey: "same" }), item())
      const b = await store.create("item", meta(B, { idempotencyKey: "same" }), item())
      check(a.id !== b.id, "two owners, two records")
      same(b.ownerId, B, "owner of the second")
    },
  },
  {
    name: "gift: two creates with one key at once: one record",
    async run(store) {
      const m = meta(A, { idempotencyKey: "k3" })
      const [x, y] = await Promise.all([
        store.create("item", m, item()),
        store.create("item", m, item()),
      ])
      same(x.id, y.id, "both answered with one record")
      same((await store.list("item", A)).length, 1, "one record")
    },
  },
  {
    name: "gift: an occasion has a recipient once, also when added twice at once",
    async run(store) {
      const o = await store.create("occasion", meta(), occasion())
      const r = await store.create("recipient", meta(), person())
      await store.create("occasionRecipient", meta(), pair(o.id, r.id))
      await refuses(
        () => store.create("occasionRecipient", meta(), pair(o.id, r.id)),
        GiftDuplicateError,
        "second roster row",
      )
      const r2 = await store.create("recipient", meta(), person("Cousin Example"))
      const results = await Promise.allSettled([
        store.create("occasionRecipient", meta(), pair(o.id, r2.id)),
        store.create("occasionRecipient", meta(), pair(o.id, r2.id)),
      ])
      same(results.filter((x) => x.status === "fulfilled").length, 1, "one of two at once")
      same((await store.list("occasionRecipient", A, { occasionId: o.id })).length, 2, "roster")
    },
  },
  {
    name: "gift: an archived record keeps reading, and lists skip it unless asked",
    async run(store) {
      const r = await store.create("recipient", meta(), person())
      const gone = await store.update("recipient", r.id, meta(), 1, { archived: true })
      same([gone.archived, gone.revision], [true, 2], "archived")
      same((await store.get("recipient", A, r.id))?.archived, true, "still readable")
      same((await store.list("recipient", A)).length, 0, "skipped by default")
      same((await store.list("recipient", A, { includeArchived: true })).length, 1, "listed on ask")
    },
  },
  {
    name: "gift: lists filter by occasion and item, in creation order",
    async run(store) {
      const o1 = await store.create("occasion", meta(), occasion())
      const o2 = await store.create("occasion", meta(), {
        ...occasion(),
        title: "Birthday",
        kind: "birthday",
      })
      const r1 = await store.create("recipient", meta(), person("One"))
      const r2 = await store.create("recipient", meta(), person("Two"))
      await store.create("occasionRecipient", meta(), pair(o1.id, r1.id))
      await store.create("occasionRecipient", meta(), pair(o1.id, r2.id))
      await store.create("occasionRecipient", meta(), pair(o2.id, r1.id))
      same(
        (await store.list("occasionRecipient", A, { occasionId: o1.id })).map((x) => x.recipientId),
        [r1.id, r2.id],
        "by occasion",
      )
      const i = await store.create("item", meta(), item())
      const purchase: GiftFieldsByKind["purchase"] = {
        itemId: i.id,
        merchant: null,
        currency: "USD",
        unitPriceMinor: 1999,
        ordered: 1,
        received: 0,
        cancelled: 0,
        returned: 0,
        taxMinor: null,
        shippingMinor: null,
        discountMinor: null,
        totalComplete: false,
        refundedMinor: 0,
        purchasedOn: null,
        reference: null,
      }
      await store.create("purchase", meta(), purchase)
      same((await store.list("purchase", A, { itemId: i.id })).length, 1, "by item")
      same((await store.list("purchase", A, { itemId: "nothing" })).length, 0, "other item")
    },
  },
  {
    name: "gift: every write records one event with its actor, source, prior and next",
    async run(store) {
      const r = await store.create("recipient", meta(A, { actor: "u1", source: "web" }), person())
      await store.update("recipient", r.id, meta(A, { actor: "u2", source: "mcp", at: LATER }), 1, {
        notes: "n",
      })
      const events = await store.listEvents(A, { entityId: r.id })
      same(
        events.map((e) => [
          e.kind,
          e.actor,
          e.source,
          e.at,
          e.prior?.revision ?? null,
          e.next.revision,
        ]),
        [
          ["recipient", "u1", "web", AT, null, 1],
          ["recipient", "u2", "mcp", LATER, 1, 2],
        ],
        "events",
      )
      same((await store.listEvents(A, { kind: "item" })).length, 0, "filtered by kind")
    },
  },
  {
    name: "gift: reads return copies: changing a returned row changes nothing stored",
    async run(store) {
      const r = await store.create("recipient", meta(), person())
      r.labels.push("changed")
      const read = await store.get("recipient", A, r.id)
      check(read !== null, "read")
      read.labels.push("changed")
      ;(await store.list("recipient", A))[0]?.labels.push("changed")
      same((await store.get("recipient", A, r.id))?.labels, [], "stored labels")
    },
  },
  {
    name: "gift: forgetting an owner erases their records, events and keys only",
    async run(store) {
      await store.create("recipient", meta(A, { idempotencyKey: "f" }), person())
      const kept = await store.create("recipient", meta(B), person())
      const erased = await store.forgetOwner(A)
      check(erased >= 2, `erased ${erased}, expected the record and its event`)
      same((await store.list("recipient", A, { includeArchived: true })).length, 0, "records gone")
      same((await store.listEvents(A)).length, 0, "events gone")
      same((await store.get("recipient", B, kept.id))?.id, kept.id, "other owner kept")
      const again = await store.create("recipient", meta(A, { idempotencyKey: "f" }), person("New"))
      same(again.displayName, "New", "the key is free again")
    },
  },
]
