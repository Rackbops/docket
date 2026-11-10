import { describe, expect, it } from "vitest"

import {
  type GiftFieldsByKind,
  GiftLedger,
  type GiftOccasionRecipient,
  GiftValidationError,
  type GiftWriteMeta,
  giftBuckets,
  giftCoverage,
  giftSpend,
  MemoryGiftStore,
  purchaseShares,
  splitMinor,
  stashUnits,
} from "../src/index.js"

const AT = "2026-11-01T12:00:00.000Z"
const A = "owner-a"
const meta: GiftWriteMeta = { ownerId: A, actor: A, source: "web", at: AT }

const person = (name: string): GiftFieldsByKind["recipient"] => ({
  displayName: name,
  kind: "person",
  memberIds: [],
  labels: [],
  interests: [],
  avoid: [],
  notes: null,
})

const item = (title: string, estimateMinor: number | null = null): GiftFieldsByKind["item"] => ({
  title,
  url: null,
  productKey: null,
  variant: null,
  notes: null,
  source: { kind: "manual", ref: null },
  planning: "selected",
  estimateMinor,
  currency: estimateMinor === null ? null : "USD",
})

const purchase = (
  itemId: string,
  ordered: number,
  unitPriceMinor = 2500,
  currency = "USD",
): GiftFieldsByKind["purchase"] => ({
  itemId,
  merchant: "A shop",
  currency,
  unitPriceMinor,
  ordered,
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
  purchaseId: string | null,
  shared = false,
): GiftFieldsByKind["allocation"] => ({
  itemId,
  occasionId,
  recipientIds,
  quantity: 1,
  shared,
  purchaseId,
  handoff: "none",
  givenOn: null,
})

/** An owner with a Christmas, `n` cousins on its roster, and one item. */
async function family(n: number, target: number | null = null) {
  const store = new MemoryGiftStore()
  const ledger = new GiftLedger(store)
  const xmas = await ledger.create("occasion", meta, {
    kind: "christmas",
    title: "Christmas 2026",
    date: "2026-12-25",
    timeZone: null,
    year: 2026,
    currency: "USD",
    budgetMinor: null,
  })
  const people = []
  for (let i = 1; i <= n; i += 1) {
    const r = await ledger.create("recipient", meta, person(`Cousin ${i}`))
    await ledger.create("occasionRecipient", meta, {
      occasionId: xmas.id,
      recipientId: r.id,
      target,
      budgetMinor: null,
      decision: "planning",
      skipReason: null,
    })
    people.push(r)
  }
  const game = await ledger.create("item", meta, item("Card game", 2000))
  const view = async () => {
    const allocations = await ledger.list("allocation", A, { includeArchived: true })
    const purchases = await ledger.list("purchase", A, { includeArchived: true })
    const buckets = giftBuckets(allocations, purchases)
    const roster = await ledger.list("occasionRecipient", A)
    const coverage = (r: { id: string }) =>
      giftCoverage(roster.find((x) => x.recipientId === r.id) as GiftOccasionRecipient, buckets)
    return { allocations, purchases, buckets, coverage, roster }
  }
  return { ledger, xmas, people, game, view }
}

describe("allocation", () => {
  it("six copies cover six people, cost the line once, and a seventh is refused", async () => {
    const f = await family(7)
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 6))
    for (const r of f.people.slice(0, 6)) {
      await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [r.id], p.id))
    }
    const seventh = allocation(f.game.id, f.xmas.id, [f.people[6]?.id as string], p.id)
    await expect(f.ledger.create("allocation", meta, seventh)).rejects.toThrow(
      "keeps 6 units; this would allocate 7",
    )
    const v = await f.view()
    expect(v.buckets.map((b) => b.filled)).toEqual([1, 1, 1, 1, 1, 1])
    expect(f.people.slice(0, 6).map((r) => v.coverage(r).status)).toEqual(Array(6).fill("awaiting"))
    expect(v.coverage(f.people[6] as { id: string }).status).toBe("needs-planning")
    const [usd] = giftSpend(v.purchases, v.allocations, [])
    expect(usd?.spentMinor).toBe(6 * 2500)
    await f.ledger.update("purchase", p.id, meta, 1, { ordered: 7 })
    expect((await f.ledger.create("allocation", meta, seventh)).purchaseId).toBe(p.id)
  })

  it("refuses moving units onto another occasion past what the purchase keeps", async () => {
    const f = await family(1)
    const birthday = await f.ledger.create("occasion", meta, {
      kind: "birthday",
      title: "Birthday",
      date: null,
      timeZone: null,
      year: null,
      currency: "USD",
      budgetMinor: null,
    })
    const r = f.people[0] as { id: string }
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 1))
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [r.id], p.id))
    await expect(
      f.ledger.create("allocation", meta, allocation(f.game.id, birthday.id, [r.id], p.id)),
    ).rejects.toThrow(GiftValidationError)
  })

  it("one shared gift covers a two-person household once and nobody else", async () => {
    const f = await family(3)
    const [p1, p2, p3] = f.people as [{ id: string }, { id: string }, { id: string }]
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 1, 8000))
    await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p1.id, p2.id], p.id, true),
    )
    const v = await f.view()
    expect([v.coverage(p1).status, v.coverage(p2).status, v.coverage(p3).status]).toEqual([
      "awaiting",
      "awaiting",
      "needs-planning",
    ])
    expect(giftSpend(v.purchases, v.allocations, [])[0]?.spentMinor).toBe(8000)
    const split = purchaseShares(v.purchases[0] as never, v.buckets, v.allocations)
    expect(split.shares.map((s) => s.minor)).toEqual([4000, 4000])
    expect(split.unallocatedMinor).toBe(0)
  })

  it("a stash bought before it is assigned covers nobody until it is", async () => {
    const f = await family(2)
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 2))
    let v = await f.view()
    expect(stashUnits(v.purchases[0] as never, v.allocations)).toBe(2)
    expect(f.people.map((r) => v.coverage(r).status)).toEqual(["needs-planning", "needs-planning"])
    await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [f.people[0]?.id as string], p.id),
    )
    v = await f.view()
    expect(stashUnits(v.purchases[0] as never, v.allocations)).toBe(1)
    expect(f.people.map((r) => v.coverage(r).status)).toEqual(["awaiting", "needs-planning"])
  })

  it("a partial arrival marks only the units that came", async () => {
    const f = await family(4)
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 4))
    await f.ledger.create(
      "allocation",
      meta,
      allocation(
        f.game.id,
        f.xmas.id,
        f.people.map((r) => r.id),
        p.id,
      ),
    )
    await f.ledger.update("purchase", p.id, meta, 1, { received: 2 })
    const v = await f.view()
    expect(f.people.map((r) => v.coverage(r).status)).toEqual([
      "purchased",
      "purchased",
      "awaiting",
      "awaiting",
    ])
  })

  it("a partial return with refund reopens only the last gap and refunds once", async () => {
    const f = await family(3)
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 3))
    await f.ledger.create(
      "allocation",
      meta,
      allocation(
        f.game.id,
        f.xmas.id,
        f.people.map((r) => r.id),
        p.id,
      ),
    )
    await f.ledger.update("purchase", p.id, meta, 1, { received: 3, returned: 1 })
    let v = await f.view()
    expect(f.people.map((r) => v.coverage(r).status)).toEqual(["purchased", "purchased", "planned"])
    let [usd] = giftSpend(v.purchases, v.allocations, [])
    expect([usd?.spentMinor, usd?.pendingRefundMinor, usd?.netMinor]).toEqual([7500, 2500, 7500])
    await f.ledger.update("purchase", p.id, meta, 2, { refundedMinor: 2500 })
    v = await f.view()
    ;[usd] = giftSpend(v.purchases, v.allocations, [])
    expect([usd?.spentMinor, usd?.pendingRefundMinor, usd?.netMinor]).toEqual([7500, 0, 5000])
  })

  it("a replacement fills the gap a return reopened", async () => {
    const f = await family(2)
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 2))
    await f.ledger.create(
      "allocation",
      meta,
      allocation(
        f.game.id,
        f.xmas.id,
        f.people.map((r) => r.id),
        p.id,
      ),
    )
    await f.ledger.update("purchase", p.id, meta, 1, { received: 2, returned: 1 })
    let v = await f.view()
    expect(f.people.map((r) => v.coverage(r).status)).toEqual(["purchased", "planned"])
    await f.ledger.update("purchase", p.id, meta, 2, { ordered: 3 })
    v = await f.view()
    expect(f.people.map((r) => v.coverage(r).status)).toEqual(["purchased", "awaiting"])
  })

  it("after a return, gifts on that purchase stay editable, but none may grow", async () => {
    const f = await family(3)
    const [p1, p2, p3] = f.people as [{ id: string }, { id: string }, { id: string }]
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 3))
    const a1 = await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p1.id], p.id),
    )
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [p2.id], p.id))
    const a3 = await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p3.id], p.id),
    )
    await f.ledger.update("purchase", p.id, meta, 1, { received: 3, returned: 1 })
    const given = await f.ledger.update("allocation", a1.id, meta, 1, {
      handoff: "given",
      givenOn: "2026-12-25",
    })
    expect(given.handoff).toBe("given")
    await expect(f.ledger.update("allocation", a1.id, meta, 2, { quantity: 2 })).rejects.toThrow(
      "keeps 2 units; this would allocate 4",
    )
    const moved = await f.ledger.update("allocation", a3.id, meta, 1, { purchaseId: null })
    expect(moved.purchaseId).toBeNull()
    const other = await f.ledger.create("purchase", meta, purchase(f.game.id, 1))
    const elsewhere = await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p3.id], other.id),
    )
    await expect(
      f.ledger.update("allocation", elsewhere.id, meta, 1, { purchaseId: p.id }),
    ).rejects.toThrow("keeps 2 units; this would allocate 3")
  })

  it("an archived allocation may change while its purchase is full", async () => {
    const f = await family(2)
    const [p1, p2] = f.people as [{ id: string }, { id: string }]
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 1))
    const old = await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p1.id], p.id),
    )
    await f.ledger.update("allocation", old.id, meta, 1, { archived: true })
    const freed = await f.view()
    expect(stashUnits(freed.purchases[0] as never, freed.allocations)).toBe(1)
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [p2.id], p.id))
    const edited = await f.ledger.update("allocation", old.id, meta, 2, { quantity: 2 })
    expect([edited.archived, edited.quantity]).toEqual([true, 2])
    const v = await f.view()
    expect(stashUnits(v.purchases[0] as never, v.allocations)).toBe(0)
  })

  it("an archived purchase fills nothing, costs nothing and takes no new gift", async () => {
    const f = await family(2)
    const [p1, p2] = f.people as [{ id: string }, { id: string }]
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 2))
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [p1.id], p.id))
    await f.ledger.update("purchase", p.id, meta, 1, { archived: true })
    const v = await f.view()
    expect(v.coverage(p1).status).toBe("planned")
    expect(stashUnits(v.purchases[0] as never, v.allocations)).toBe(0)
    expect(giftSpend(v.purchases, v.allocations, [f.game])).toEqual([])
    await expect(
      f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [p2.id], p.id)),
    ).rejects.toThrow("keeps 0 units")
  })

  it("a cancellation reopens the gift allocated last, not an earlier one", async () => {
    const f = await family(3)
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 3))
    for (const r of f.people) {
      await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [r.id], p.id))
    }
    await f.ledger.update("purchase", p.id, meta, 1, { cancelled: 1 })
    const v = await f.view()
    expect(f.people.map((r) => v.coverage(r).status)).toEqual(["awaiting", "awaiting", "planned"])
  })

  it("a reassignment covers the new recipient and reopens the old one", async () => {
    const f = await family(2)
    const [p1, p2] = f.people as [{ id: string }, { id: string }]
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 1))
    const a = await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p1.id], p.id),
    )
    await f.ledger.update("allocation", a.id, meta, 1, { recipientIds: [p2.id] })
    const v = await f.view()
    expect([v.coverage(p1).status, v.coverage(p2).status]).toEqual(["needs-planning", "awaiting"])
  })

  it("an archived allocation holds no units", async () => {
    const f = await family(2)
    const [p1, p2] = f.people as [{ id: string }, { id: string }]
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 1))
    const a = await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p1.id], p.id),
    )
    await f.ledger.update("allocation", a.id, meta, 1, { archived: true })
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [p2.id], p.id))
    const v = await f.view()
    expect([v.coverage(p1).status, v.coverage(p2).status]).toEqual(["needs-planning", "awaiting"])
    await expect(f.ledger.update("allocation", a.id, meta, 2, { archived: false })).rejects.toThrow(
      GiftValidationError,
    )
  })
})

describe("coverage", () => {
  it("one small purchase does not mark someone done while their target or decision says otherwise", async () => {
    const f = await family(1, 3)
    const r = f.people[0] as { id: string }
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 1))
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [r.id], p.id))
    let v = await f.view()
    expect([v.coverage(r).status, v.coverage(r).done, v.coverage(r).bought]).toEqual([
      "needs-planning",
      false,
      1,
    ])
    const row = v.roster[0] as GiftOccasionRecipient
    await f.ledger.update("occasionRecipient", row.id, meta, 1, { target: null })
    v = await f.view()
    expect([v.coverage(r).status, v.coverage(r).done]).toEqual(["awaiting", false])
    await f.ledger.update("occasionRecipient", row.id, meta, 2, { decision: "complete" })
    v = await f.view()
    expect(v.coverage(r).done).toBe(true)
  })

  it("a met target is done; ready, given and skipped show as such", async () => {
    const f = await family(3, 1)
    const [p1, p2, p3] = f.people as [{ id: string }, { id: string }, { id: string }]
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 2))
    const a1 = await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p1.id], p.id),
    )
    const a2 = await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p2.id], p.id),
    )
    await f.ledger.update("purchase", p.id, meta, 1, { received: 2 })
    await f.ledger.update("allocation", a1.id, meta, 1, { handoff: "wrapped" })
    await f.ledger.update("allocation", a2.id, meta, 1, {
      handoff: "given",
      givenOn: "2026-12-25",
    })
    let v = await f.view()
    const row3 = v.roster.find((x) => x.recipientId === p3.id) as GiftOccasionRecipient
    await f.ledger.update("occasionRecipient", row3.id, meta, 1, {
      decision: "skipped",
      skipReason: "Seeing them in spring",
    })
    v = await f.view()
    expect([p1, p2, p3].map((r) => [v.coverage(r).status, v.coverage(r).done])).toEqual([
      ["ready", true],
      ["given", true],
      ["skipped", true],
    ])
  })

  it("a given gift is given whatever its purchase says, and a target of 0 is a skip", async () => {
    const f = await family(2, 0)
    const [p1, p2] = f.people as [{ id: string }, { id: string }]
    await f.ledger.create("allocation", meta, {
      ...allocation(f.game.id, f.xmas.id, [p1.id], null),
      handoff: "given",
    })
    const v = await f.view()
    const row1 = v.roster.find((x) => x.recipientId === p1.id) as GiftOccasionRecipient
    await f.ledger.update("occasionRecipient", row1.id, meta, 1, { target: 1 })
    const w = await f.view()
    expect(w.coverage(p1).status).toBe("given")
    expect([v.coverage(p2).status, v.coverage(p2).done]).toEqual(["skipped", true])
  })

  it("a planned gift with no purchase is planned, not bought", async () => {
    const f = await family(1)
    const r = f.people[0] as { id: string }
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [r.id], null))
    const dropped = await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [r.id], null),
    )
    await f.ledger.update("allocation", dropped.id, meta, 1, { archived: true })
    const v = await f.view()
    expect([v.coverage(r).status, v.coverage(r).bought]).toEqual(["planned", 0])
    expect(giftSpend([], v.allocations, [f.game])[0]?.plannedMinor).toBe(2000)
  })

  it("plans a shared gift once, and a bought gift not at all", async () => {
    const f = await family(2)
    const [p1, p2] = f.people as [{ id: string }, { id: string }]
    await f.ledger.create(
      "allocation",
      meta,
      allocation(f.game.id, f.xmas.id, [p1.id, p2.id], null, true),
    )
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 1))
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [p1.id], p.id))
    const v = await f.view()
    const [usd] = giftSpend(v.purchases, v.allocations, [f.game])
    expect([usd?.plannedMinor, usd?.spentMinor]).toEqual([2000, 2500])
  })
})

describe("spend", () => {
  it("keeps USD and EUR apart, and shares reconcile to the line total", async () => {
    const f = await family(3)
    const usd = await f.ledger.create("purchase", meta, {
      ...purchase(f.game.id, 3, 300),
      taxMinor: 100,
      shippingMinor: 0,
      discountMinor: 0,
      totalComplete: true,
    })
    await f.ledger.create("purchase", meta, purchase(f.game.id, 1, 1500, "EUR"))
    await f.ledger.create(
      "allocation",
      meta,
      allocation(
        f.game.id,
        f.xmas.id,
        f.people.map((r) => r.id),
        usd.id,
      ),
    )
    const v = await f.view()
    expect(
      giftSpend(v.purchases, v.allocations, []).map((s) => [
        s.currency,
        s.spentMinor,
        s.incomplete,
      ]),
    ).toEqual([
      ["USD", 1000, false],
      ["EUR", 1500, true],
    ])
    const split = purchaseShares(v.purchases[0] as never, v.buckets, v.allocations)
    expect(split.shares.map((s) => s.minor)).toEqual([334, 333, 333])
    expect(split.shares.reduce((n, s) => n + s.minor, 0) + split.unallocatedMinor).toBe(1000)
  })

  it("leaves cancelled units out of spend, and refunds never exceed the line", async () => {
    const f = await family(1)
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 2))
    await f.ledger.update("purchase", p.id, meta, 1, { cancelled: 1 })
    const v = await f.view()
    expect(giftSpend(v.purchases, v.allocations, [])[0]?.spentMinor).toBe(2500)
    await expect(
      f.ledger.update("purchase", p.id, meta, 2, { refundedMinor: 2501 }),
    ).rejects.toThrow("refundedMinor cannot exceed the line's total")
    const adjusted = await f.ledger.update("purchase", p.id, meta, 2, { refundedMinor: 500 })
    expect(giftSpend([adjusted], [], [])[0]?.netMinor).toBe(2000)
    await expect(
      f.ledger.update("purchase", p.id, meta, 3, { discountMinor: 2600 }),
    ).rejects.toThrow("discountMinor cannot exceed")
  })

  it("gives units no gift holds their share of the line", async () => {
    const f = await family(1)
    const r = f.people[0] as { id: string }
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 3, 1000))
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [r.id], p.id))
    const v = await f.view()
    const split = purchaseShares(v.purchases[0] as never, v.buckets, v.allocations)
    expect([split.shares.map((s) => s.minor), split.unallocatedMinor]).toEqual([[1000], 2000])
  })

  it("splits a line with a returned unit over every unit it charged", async () => {
    const f = await family(2)
    const p = await f.ledger.create("purchase", meta, purchase(f.game.id, 2, 1000))
    await f.ledger.create(
      "allocation",
      meta,
      allocation(
        f.game.id,
        f.xmas.id,
        f.people.map((r) => r.id),
        p.id,
      ),
    )
    await f.ledger.update("purchase", p.id, meta, 1, { received: 2, returned: 1 })
    const v = await f.view()
    const split = purchaseShares(v.purchases[0] as never, v.buckets, v.allocations)
    expect([split.shares.map((s) => s.minor), split.unallocatedMinor]).toEqual([[1000], 1000])
  })

  it("keeps planned spend per currency too", async () => {
    const f = await family(1)
    const r = f.people[0] as { id: string }
    const euro = await f.ledger.create("item", meta, {
      ...item("Book", 1500),
      currency: "EUR",
    })
    await f.ledger.create("allocation", meta, allocation(f.game.id, f.xmas.id, [r.id], null))
    await f.ledger.create("allocation", meta, allocation(euro.id, f.xmas.id, [r.id], null))
    const v = await f.view()
    expect(
      giftSpend([], v.allocations, [f.game, euro]).map((s) => [s.currency, s.plannedMinor]),
    ).toEqual([
      ["USD", 2000],
      ["EUR", 1500],
    ])
  })

  it("splits exactly by largest remainder", () => {
    expect(splitMinor(1000, [1, 1, 1])).toEqual([334, 333, 333])
    expect(splitMinor(10, [1, 2])).toEqual([3, 7])
    expect(splitMinor(7, [0, 0])).toEqual([0, 0])
    expect(splitMinor(-5, [1, 1])).toEqual([-2, -3])
  })
})
