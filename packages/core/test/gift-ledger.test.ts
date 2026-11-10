import { describe, expect, it } from "vitest"

import {
  GIFT_FIELD_NAMES,
  type GiftFieldsByKind,
  GiftLedger,
  GiftNotFoundError,
  GiftRevisionError,
  GiftValidationError,
  type GiftWriteMeta,
  giftProblems,
  MemoryGiftStore,
} from "../src/index.js"

const AT = "2026-11-01T12:00:00.000Z"
const A = "owner-a"
const B = "owner-b"
const meta = (ownerId = A): GiftWriteMeta => ({ ownerId, actor: ownerId, source: "web", at: AT })

const person = (name = "Aunt Example"): GiftFieldsByKind["recipient"] => ({
  displayName: name,
  kind: "person",
  memberIds: [],
  labels: [],
  interests: [],
  avoid: [],
  notes: null,
})

const occasion: GiftFieldsByKind["occasion"] = {
  kind: "christmas",
  title: "Christmas 2026",
  date: "2026-12-25",
  timeZone: null,
  year: 2026,
  currency: "USD",
  budgetMinor: 20000,
}

const item: GiftFieldsByKind["item"] = {
  title: "Puzzle",
  url: null,
  productKey: null,
  variant: null,
  notes: null,
  source: { kind: "manual", ref: null },
  planning: "idea",
  estimateMinor: 2500,
  currency: "USD",
}

const purchase = (itemId: string): GiftFieldsByKind["purchase"] => ({
  itemId,
  merchant: "A shop",
  currency: "USD",
  unitPriceMinor: 2499,
  ordered: 6,
  received: 0,
  cancelled: 0,
  returned: 0,
  taxMinor: null,
  shippingMinor: null,
  discountMinor: null,
  totalComplete: false,
  refundedMinor: 0,
  purchasedOn: "2026-11-20",
  reference: null,
})

const allocation = (
  itemId: string,
  occasionId: string,
  recipientIds: string[],
  purchaseId: string | null = null,
): GiftFieldsByKind["allocation"] => ({
  itemId,
  occasionId,
  recipientIds,
  quantity: 1,
  shared: false,
  purchaseId,
  handoff: "none",
  givenOn: null,
})

function fresh() {
  return new GiftLedger(new MemoryGiftStore())
}

async function refusal(work: Promise<unknown>): Promise<string[]> {
  try {
    await work
  } catch (e) {
    expect(e).toBeInstanceOf(GiftValidationError)
    return (e as GiftValidationError).problems
  }
  throw new Error("not refused")
}

describe("gift validation", () => {
  it("refuses money that is not whole minor units, and a bad currency", async () => {
    const problems = await refusal(
      fresh().create("occasion", meta(), { ...occasion, budgetMinor: 19.99, currency: "usd" }),
    )
    expect(problems).toEqual([
      "currency must be an ISO 4217 code",
      "budgetMinor must be a whole number of at least 0",
    ])
  })

  it("refuses a negative quantity and impossible purchase counts", async () => {
    const ledger = fresh()
    const i = await ledger.create("item", meta(), item)
    const problems = await refusal(
      ledger.create("purchase", meta(), {
        ...purchase(i.id),
        received: 5,
        cancelled: 2,
        returned: 6,
      }),
    )
    expect(problems).toEqual([
      "received and cancelled together cannot exceed ordered",
      "returned cannot exceed received",
    ])
    expect(
      await refusal(
        ledger.create("allocation", meta(), { ...allocation(i.id, "x", ["y"]), quantity: 0 }),
      ),
    ).toEqual(["quantity must be a whole number of at least 1"])
  })

  it("refuses an unknown field instead of dropping it, and a missing one", () => {
    expect(giftProblems("group", { name: "Aunts", memberIds: [], color: "red" } as never)).toEqual([
      "color is not a group field",
    ])
    expect(giftProblems("group", { name: "Aunts" } as never)).toEqual(["memberIds is missing"])
  })

  it("takes blank-free free-text labels and refuses empty or long ones", () => {
    expect(giftProblems("recipient", { ...person(), labels: ["cousin", "adult"] })).toEqual([])
    expect(giftProblems("recipient", { ...person(), labels: [" "] })).toEqual([
      "labels entries must be 1 to 40 characters",
    ])
    expect(giftProblems("recipient", { ...person(), labels: ["x".repeat(41)] })).toEqual([
      "labels entries must be 1 to 40 characters",
    ])
  })

  it("checks dates, enums and the givenOn rule", () => {
    expect(
      giftProblems("occasion", { ...occasion, date: "2026-13-01", kind: "party" as never }),
    ).toEqual([
      "kind must be one of christmas, birthday, anniversary, custom",
      "date must be a date YYYY-MM-DD",
    ])
    expect(
      giftProblems("allocation", { ...allocation("i", "o", ["r"]), givenOn: "2026-12-25" }),
    ).toEqual(["givenOn is only for a given gift"])
    expect(giftProblems("occasion", { ...occasion, date: "2026-02-31" })).toEqual([
      "date must be a date YYYY-MM-DD",
    ])
    expect(giftProblems("occasion", { ...occasion, date: "2028-02-29", year: 2028 })).toEqual([])
    expect(giftProblems("occasion", { ...occasion, date: "2027-12-25" })).toEqual([
      "year must be the date's year",
    ])
  })

  it("marks a purchase's total complete only when tax, shipping and discount are known", () => {
    expect(giftProblems("purchase", { ...purchase("i"), totalComplete: true })).toEqual([
      "totalComplete needs tax, shipping and discount, each 0 when there is none",
    ])
    expect(
      giftProblems("purchase", {
        ...purchase("i"),
        totalComplete: true,
        taxMinor: 150,
        shippingMinor: 0,
        discountMinor: 0,
      }),
    ).toEqual([])
  })

  it("lists every field name of every kind", () => {
    expect(Object.keys(GIFT_FIELD_NAMES).sort()).toEqual([
      "allocation",
      "group",
      "item",
      "occasion",
      "occasionRecipient",
      "purchase",
      "recipient",
    ])
  })
})

describe("gift references", () => {
  it("refuses another owner's ids exactly as missing ones", async () => {
    const ledger = fresh()
    const theirs = {
      recipient: await ledger.create("recipient", meta(B), person()),
      occasion: await ledger.create("occasion", meta(B), occasion),
      item: await ledger.create("item", meta(B), item),
    }
    const p = await ledger.create("purchase", meta(B), purchase(theirs.item.id))
    const mine = {
      recipient: await ledger.create("recipient", meta(), person("Cousin Example")),
      occasion: await ledger.create("occasion", meta(), occasion),
      item: await ledger.create("item", meta(), item),
    }
    const attempts: Promise<unknown>[] = [
      ledger.create("group", meta(), { name: "Aunts", memberIds: [theirs.recipient.id] }),
      ledger.create("occasionRecipient", meta(), {
        occasionId: theirs.occasion.id,
        recipientId: mine.recipient.id,
        target: null,
        budgetMinor: null,
        decision: "planning",
        skipReason: null,
      }),
      ledger.create("purchase", meta(), purchase(theirs.item.id)),
      ledger.create(
        "allocation",
        meta(),
        allocation(mine.item.id, mine.occasion.id, [theirs.recipient.id]),
      ),
      ledger.create(
        "allocation",
        meta(),
        allocation(mine.item.id, mine.occasion.id, [mine.recipient.id], p.id),
      ),
      ledger.create("allocation", meta(), allocation(mine.item.id, mine.occasion.id, ["gr999"])),
    ]
    for (const attempt of attempts) await expect(attempt).rejects.toThrow(GiftNotFoundError)
    expect(await ledger.list("group", A)).toEqual([])
    expect(await ledger.list("allocation", A)).toEqual([])
  })

  it("refuses a household of households and a purchase of another item", async () => {
    const ledger = fresh()
    const a = await ledger.create("recipient", meta(), person("One"))
    const home = await ledger.create("recipient", meta(), {
      ...person("Home"),
      kind: "household",
      memberIds: [a.id],
    })
    await expect(
      ledger.create("recipient", meta(), {
        ...person("Bigger"),
        kind: "household",
        memberIds: [home.id],
      }),
    ).rejects.toThrow(GiftValidationError)
    const o = await ledger.create("occasion", meta(), occasion)
    const one = await ledger.create("item", meta(), item)
    const two = await ledger.create("item", meta(), { ...item, title: "Book" })
    const p = await ledger.create("purchase", meta(), purchase(one.id))
    await expect(
      ledger.create("allocation", meta(), allocation(two.id, o.id, [a.id], p.id)),
    ).rejects.toThrow("purchase")
    const ok = await ledger.create("allocation", meta(), allocation(one.id, o.id, [a.id], p.id))
    expect(ok.purchaseId).toBe(p.id)
  })

  it("checks an update whole: a patch may not break the record or point elsewhere", async () => {
    const ledger = fresh()
    const r = await ledger.create("recipient", meta(), person())
    await expect(
      ledger.update("recipient", r.id, meta(), 1, { kind: "household" }),
    ).rejects.toThrow(GiftValidationError)
    const other = await ledger.create("recipient", meta(B), person())
    const g = await ledger.create("group", meta(), { name: "Aunts", memberIds: [r.id] })
    await expect(
      ledger.update("group", g.id, meta(), 1, { memberIds: [r.id, other.id] }),
    ).rejects.toThrow(GiftNotFoundError)
    const archived = await ledger.update("group", g.id, meta(), 1, { archived: true })
    expect([archived.archived, archived.revision, archived.memberIds]).toEqual([true, 2, [r.id]])
    await expect(ledger.update("group", g.id, meta(B), 2, { name: "x" })).rejects.toThrow(
      GiftNotFoundError,
    )
  })
})

describe("rules kept from both sides", () => {
  it("refuses a recipient that lists itself", async () => {
    const ledger = fresh()
    const p = await ledger.create("recipient", meta(), person())
    await expect(
      ledger.update("recipient", p.id, meta(), 1, { kind: "household", memberIds: [p.id] }),
    ).rejects.toThrow(GiftValidationError)
  })

  it("keeps a household's member a person", async () => {
    const ledger = fresh()
    const p = await ledger.create("recipient", meta(), person("P"))
    const q = await ledger.create("recipient", meta(), person("Q"))
    await ledger.create("recipient", meta(), {
      ...person("Home"),
      kind: "household",
      memberIds: [p.id],
    })
    await expect(
      ledger.update("recipient", p.id, meta(), 1, { kind: "household", memberIds: [q.id] }),
    ).rejects.toThrow(GiftValidationError)
    expect((await ledger.get("recipient", A, p.id))?.kind).toBe("person")
    const free = await ledger.update("recipient", q.id, meta(), 1, {
      kind: "household",
      memberIds: [p.id],
    })
    expect(free.kind).toBe("household")
  })

  it("keeps an allocated purchase on its item", async () => {
    const ledger = fresh()
    const i1 = await ledger.create("item", meta(), item)
    const i2 = await ledger.create("item", meta(), { ...item, title: "Other" })
    const o = await ledger.create("occasion", meta(), occasion)
    const r = await ledger.create("recipient", meta(), person())
    const bought = await ledger.create("purchase", meta(), purchase(i1.id))
    const spare = await ledger.create("purchase", meta(), purchase(i1.id))
    await ledger.create("allocation", meta(), allocation(i1.id, o.id, [r.id], bought.id))
    await expect(
      ledger.update("purchase", bought.id, meta(), 1, { itemId: i2.id }),
    ).rejects.toThrow(GiftValidationError)
    expect((await ledger.update("purchase", spare.id, meta(), 1, { itemId: i2.id })).itemId).toBe(
      i2.id,
    )
  })

  it("lets a record point at an archived one", async () => {
    const ledger = fresh()
    const r = await ledger.create("recipient", meta(), person())
    await ledger.update("recipient", r.id, meta(), 1, { archived: true })
    const g = await ledger.create("group", meta(), { name: "Old friends", memberIds: [r.id] })
    expect(g.memberIds).toEqual([r.id])
  })
})

describe("retries and stale writes through the ledger", () => {
  it("answers a replayed update with the first result after the record moved on", async () => {
    const ledger = fresh()
    const i = await ledger.create("item", meta(), item)
    const p = await ledger.create("purchase", meta(), { ...purchase(i.id), ordered: 1 })
    const keyed = { ...meta(), idempotencyKey: "retry-1" }
    const first = await ledger.update("purchase", p.id, keyed, 1, { received: 1 })
    await ledger.update("purchase", p.id, meta(), 2, { received: 0, cancelled: 1 })
    const again = await ledger.update("purchase", p.id, keyed, 1, { received: 1 })
    expect([again.revision, again.received]).toEqual([first.revision, 1])
    expect((await ledger.get("purchase", A, p.id))?.revision).toBe(3)
  })

  it("answers a replayed create with the first record after a reference changed", async () => {
    const ledger = fresh()
    const p = await ledger.create("recipient", meta(), person("P"))
    const keyed = { ...meta(), idempotencyKey: "retry-2" }
    const home = { ...person("Home"), kind: "household" as const, memberIds: [p.id] }
    const first = await ledger.create("recipient", keyed, home)
    await ledger.update("recipient", p.id, meta(), 1, { archived: true })
    const reordered = Object.fromEntries(Object.entries(home).reverse()) as typeof home
    expect((await ledger.create("recipient", keyed, reordered)).id).toBe(first.id)
    expect(await ledger.list("recipient", A, { includeArchived: true })).toHaveLength(2)
  })

  it("answers a retry from the store before reading or judging anything", async () => {
    const store = new MemoryGiftStore()
    let reads = 0
    const counted = Object.assign(Object.create(store), {
      get: ((...args: Parameters<MemoryGiftStore["get"]>) => {
        reads += 1
        return store.get(...args)
      }) as MemoryGiftStore["get"],
    }) as MemoryGiftStore
    const ledger = new GiftLedger(counted)
    const p = await ledger.create("recipient", meta(), person("P"))
    const keyed = { ...meta(), idempotencyKey: "retry-3" }
    const home = { ...person("Home"), kind: "household" as const, memberIds: [p.id] }
    const first = await ledger.create("recipient", keyed, home)
    reads = 0
    expect((await ledger.create("recipient", keyed, home)).id).toBe(first.id)
    expect(reads).toBe(0)
    const k2 = { ...meta(), idempotencyKey: "retry-4" }
    const again = await ledger.update("recipient", p.id, k2, 1, { notes: "y" })
    reads = 0
    expect((await ledger.update("recipient", p.id, k2, 1, { notes: "y" })).revision).toBe(
      again.revision,
    )
    expect(reads).toBe(0)
  })

  it("refuses a stale update as stale, not as bad fields", async () => {
    const ledger = fresh()
    const i = await ledger.create("item", meta(), item)
    const p = await ledger.create("purchase", meta(), { ...purchase(i.id), ordered: 1 })
    await ledger.update("purchase", p.id, meta(), 1, { cancelled: 1 })
    await expect(ledger.update("purchase", p.id, meta(), 1, { received: 1 })).rejects.toThrow(
      GiftRevisionError,
    )
  })

  it("ignores an undefined key and refuses a patch that is not an object", async () => {
    const ledger = fresh()
    const r = await ledger.create("recipient", meta(), person())
    const next = await ledger.update("recipient", r.id, meta(), 1, {
      archived: undefined,
      notes: "tea",
    })
    expect([next.archived, next.notes]).toEqual([false, "tea"])
    await expect(ledger.update("recipient", r.id, meta(), 2, null as never)).rejects.toThrow(
      GiftValidationError,
    )
  })
})

describe("a gift recipient is not a tracker person", () => {
  it("carries no user, Discord, login or delivery field", async () => {
    const ledger = fresh()
    const r = await ledger.create("recipient", meta(), person())
    expect(Object.keys(r).sort()).toEqual([
      "archived",
      "avoid",
      "createdAt",
      "displayName",
      "id",
      "interests",
      "kind",
      "labels",
      "memberIds",
      "notes",
      "ownerId",
      "revision",
      "updatedAt",
    ])
    expect(giftProblems("recipient", { ...person(), discordId: "d1" } as never)).toEqual([
      "discordId is not a recipient field",
    ])
  })

  it("keeps the history of every write", async () => {
    const ledger = fresh()
    const r = await ledger.create("recipient", meta(), person())
    await ledger.update("recipient", r.id, meta(), 1, { notes: "likes tea" })
    const events = await ledger.history(A, { entityId: r.id })
    expect(events.map((e) => [e.prior?.revision ?? null, e.next.revision, e.source])).toEqual([
      [null, 1, "web"],
      [1, 2, "web"],
    ])
  })
})
