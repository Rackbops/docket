import { describe, expect, it } from "vitest"

import {
  GIFT_FIELD_NAMES,
  type GiftFieldsByKind,
  GiftLedger,
  GiftNotFoundError,
  GiftValidationError,
  type GiftWriteMeta,
  giftProblems,
  MemoryGiftStore,
  MemoryStore,
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

describe("a gift recipient is not a tracker person", () => {
  it("carries no user, Discord, login or delivery field and writes nothing to the tracker store", async () => {
    const tracker = new MemoryStore()
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
    expect(await tracker.listUsers()).toEqual([])
    expect(await tracker.listTasks()).toEqual([])
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
