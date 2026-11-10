import { describe, expect, it } from "vitest"

import {
  editGroupMembers,
  type GiftFieldsByKind,
  GiftLedger,
  type GiftOccasion,
  GiftValidationError,
  type GiftWriteMeta,
  giftBuckets,
  MemoryGiftStore,
  occasionBudget,
  planGroupSync,
  previewGroupSync,
  previewRoster,
  rosterIds,
} from "../src/index.js"

const AT = "2026-11-01T12:00:00.000Z"
const A = "owner-a"
const meta: GiftWriteMeta = { ownerId: A, actor: A, source: "web", at: AT }

const person = (name: string, labels: string[] = []): GiftFieldsByKind["recipient"] => ({
  displayName: name,
  kind: "person",
  memberIds: [],
  labels,
  interests: [],
  avoid: [],
  notes: null,
})

const christmas = (
  year: number,
  groupIds: string[],
  includeIds: string[] = [],
  excludeIds: string[] = [],
): GiftFieldsByKind["occasion"] => ({
  kind: "christmas",
  title: `Christmas ${year}`,
  date: `${year}-12-25`,
  timeZone: null,
  year,
  currency: "USD",
  budgetMinor: 50000,
  groupIds,
  includeIds,
  excludeIds,
})

function setup() {
  const ledger = new GiftLedger(new MemoryGiftStore())
  const people = async (...names: string[]) => {
    const out = []
    for (const n of names) out.push(await ledger.create("recipient", meta, person(n)))
    return out
  }
  /** Previews and applies a sync with the given decisions; returns the occasion's live roster. */
  const sync = async (
    occasion: GiftOccasion,
    decisions: Parameters<typeof planGroupSync>[1] = {},
  ) => {
    const preview = await previewNow(occasion)
    await ledger.applyGiftSync(meta, planGroupSync(preview, decisions))
    return liveRoster(occasion.id)
  }
  const previewNow = async (occasion: GiftOccasion) => {
    const allocations = await ledger.list("allocation", A, { includeArchived: true })
    const purchases = await ledger.list("purchase", A, { includeArchived: true })
    return previewGroupSync(
      occasion,
      await ledger.list("group", A, { includeArchived: true }),
      await ledger.list("occasionRecipient", A, {
        occasionId: occasion.id,
        includeArchived: true,
      }),
      allocations,
      giftBuckets(allocations, purchases),
    )
  }
  const liveRoster = async (occasionId: string) =>
    (await ledger.list("occasionRecipient", A, { occasionId })).map((r) => r.recipientId)
  return { ledger, people, sync, previewNow, liveRoster }
}

describe("group membership", () => {
  it("adds and removes in one reviewed edit, without duplicates", () => {
    expect(
      editGroupMembers({ memberIds: ["a", "b", "c"] }, ["d", "a", "d", "e"], ["b", "x"]),
    ).toEqual({ added: ["d", "e"], removed: ["b"], memberIds: ["a", "c", "d", "e"] })
    expect(editGroupMembers({ memberIds: ["a"] }, ["b"], ["b"])).toEqual({
      added: [],
      removed: [],
      memberIds: ["a"],
    })
  })

  it("never depends on a label value", async () => {
    const s = setup()
    const [blank, custom] = await s.people("Blank", "Custom")
    const b = blank as { id: string; revision: number }
    const c = custom as { id: string; revision: number }
    await s.ledger.update("recipient", c.id, meta, c.revision, { labels: ["cousin", "Family 2"] })
    const g = await s.ledger.create("group", meta, { name: "Cousins", memberIds: [b.id, c.id] })
    const before = rosterIds(previewRoster([g], [], []))
    await s.ledger.update("recipient", b.id, meta, b.revision, { labels: ["not a cousin"] })
    await s.ledger.update("recipient", c.id, meta, c.revision + 1, { labels: [] })
    const after = rosterIds(previewRoster([await s.ledger.get("group", A, g.id)] as never, [], []))
    expect([before, after]).toEqual([
      [b.id, c.id],
      [b.id, c.id],
    ])
  })
})

describe("occasion rosters", () => {
  it("names each group once per person, even from a list that repeats them", () => {
    expect(previewRoster([{ id: "g1", memberIds: ["r1", "r1"] }], ["r1"], [])).toEqual([
      { recipientId: "r1", groupIds: ["g1"], included: true, excluded: false },
    ])
  })

  it("Aunts and Cousins with one shared member: one roster entry, one budget each", async () => {
    const s = setup()
    const [ann, bea, cal, dee] = await s.people("Ann", "Bea", "Cal", "Dee")
    const ids = [ann, bea, cal, dee].map((r) => (r as { id: string }).id) as [
      string,
      string,
      string,
      string,
    ]
    const aunts = await s.ledger.create("group", meta, {
      name: "Aunts",
      memberIds: [ids[0], ids[1]],
    })
    const cousins = await s.ledger.create("group", meta, {
      name: "Cousins",
      memberIds: [ids[1], ids[2], ids[3]],
    })
    const preview = previewRoster([aunts, cousins], [], [])
    expect(preview.map((e) => [e.recipientId, e.groupIds])).toEqual([
      [ids[0], [aunts.id]],
      [ids[1], [aunts.id, cousins.id]],
      [ids[2], [cousins.id]],
      [ids[3], [cousins.id]],
    ])
    const xmas = await s.ledger.create("occasion", meta, christmas(2026, [aunts.id, cousins.id]))
    expect(await s.sync(xmas)).toEqual(ids)
    const rows = await s.ledger.list("occasionRecipient", A, { occasionId: xmas.id })
    for (const r of rows) {
      await s.ledger.update("occasionRecipient", r.id, meta, r.revision, { budgetMinor: 3000 })
    }
    const budget = occasionBudget(
      xmas,
      await s.ledger.list("occasionRecipient", A, { occasionId: xmas.id }),
    )
    expect(budget).toEqual({
      currency: "USD",
      budgetMinor: 50000,
      recipientBudgetsMinor: 12000,
      recipients: 4,
    })
  })

  it("shows hand overrides and keeps excluded people off the roster", async () => {
    const s = setup()
    const [ann, bea, gus] = (await s.people("Ann", "Bea", "Gus")) as { id: string }[] as [
      { id: string },
      { id: string },
      { id: string },
    ]
    const g = await s.ledger.create("group", meta, { name: "Aunts", memberIds: [ann.id, bea.id] })
    const preview = previewRoster([g], [gus.id], [bea.id])
    expect(preview.map((e) => [e.recipientId, e.included, e.excluded])).toEqual([
      [ann.id, false, false],
      [bea.id, false, true],
      [gus.id, true, false],
    ])
    const xmas = await s.ledger.create(
      "occasion",
      meta,
      christmas(2026, [g.id], [gus.id], [bea.id]),
    )
    expect(await s.sync(xmas)).toEqual([ann.id, gus.id])
    await expect(
      s.ledger.create("occasion", meta, christmas(2027, [g.id], [gus.id], [gus.id])),
    ).rejects.toThrow("both included and excluded")
  })

  it("#92's group story: Cousins grows and shrinks, is reused next year, and last year stays", async () => {
    const s = setup()
    const cousins3 = (await s.people("C1", "C2", "C3")) as { id: string }[]
    const [c1, c2, c3] = cousins3 as [{ id: string }, { id: string }, { id: string }]
    let group = await s.ledger.create("group", meta, {
      name: "Cousins",
      memberIds: [c1.id, c2.id, c3.id],
    })
    const x26 = await s.ledger.create("occasion", meta, christmas(2026, [group.id]))
    expect(await s.sync(x26)).toEqual([c1.id, c2.id, c3.id])

    const [spouse, baby] = (await s.people("Spouse", "Baby")) as { id: string }[] as [
      { id: string },
      { id: string },
    ]
    const edit = editGroupMembers(group, [spouse.id, baby.id], [c2.id])
    group = await s.ledger.update("group", group.id, meta, group.revision, {
      memberIds: edit.memberIds,
    })
    expect(group.id).toBe(x26.groupIds[0])
    expect(await s.ledger.get("recipient", A, c2.id)).not.toBeNull()

    const x26now = (await s.ledger.get("occasion", A, x26.id)) as GiftOccasion
    await s.ledger.update("occasion", x26.id, meta, x26now.revision, { archived: true })
    const archived = (await s.ledger.get("occasion", A, x26.id)) as GiftOccasion
    expect(() => previewGroupSync(archived, [group], [], [], [])).toThrow(GiftValidationError)
    expect(await s.liveRoster(x26.id)).toEqual([c1.id, c2.id, c3.id])

    const x27 = await s.ledger.create("occasion", meta, christmas(2027, [group.id]))
    const roster27 = await s.sync(x27)
    expect(roster27).toEqual([c1.id, c3.id, spouse.id, baby.id])
    expect(new Set(roster27).size).toBe(roster27.length)
    expect(await s.liveRoster(x26.id)).toEqual([c1.id, c2.id, c3.id])
    expect((await s.ledger.list("recipient", A)).length).toBe(5)
  })

  it("a sync that drops someone holding a gift does nothing until each gift has a decision", async () => {
    const s = setup()
    const [c1, c2, c3] = (await s.people("C1", "C2", "C3")) as { id: string }[] as [
      { id: string },
      { id: string },
      { id: string },
    ]
    const group = await s.ledger.create("group", meta, {
      name: "Cousins",
      memberIds: [c1.id, c2.id, c3.id],
    })
    const xmas = await s.ledger.create("occasion", meta, christmas(2026, [group.id]))
    await s.sync(xmas)
    const game = await s.ledger.create("item", meta, {
      title: "Card game",
      url: null,
      productKey: null,
      variant: null,
      notes: null,
      source: { kind: "manual", ref: null },
      planning: "selected",
      estimateMinor: null,
      currency: null,
    })
    const p = await s.ledger.create("purchase", meta, {
      itemId: game.id,
      merchant: null,
      currency: "USD",
      unitPriceMinor: 1000,
      ordered: 2,
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
    })
    const gift = (recipientIds: string[], purchaseId: string | null) =>
      s.ledger.create("allocation", meta, {
        itemId: game.id,
        occasionId: xmas.id,
        recipientIds,
        quantity: 1,
        shared: false,
        purchaseId,
        handoff: "none",
        givenOn: null,
      })
    const bought = await gift([c2.id], p.id)
    const planned = await gift([c2.id, c3.id], null)
    const both = await gift([c3.id], p.id)
    await s.ledger.update("group", group.id, meta, group.revision, { memberIds: [c1.id, c3.id] })

    const preview = await s.previewNow(xmas)
    expect(preview.removed.map((r) => [r.row.recipientId, r.coverage.status])).toEqual([
      [c2.id, "awaiting"],
    ])
    expect(preview.affected.map((a) => [a.allocationId, a.dropped, a.bought])).toEqual([
      [bought.id, [c2.id], true],
      [planned.id, [c2.id], false],
    ])
    expect(() => planGroupSync(preview, { [bought.id]: { action: "keep" } })).toThrow(
      `allocation ${planned.id} needs keep, reassign or unassign`,
    )
    expect(await s.liveRoster(xmas.id)).toEqual([c1.id, c2.id, c3.id])

    const roster = await s.sync(xmas, {
      [bought.id]: { action: "reassign", recipientIds: [c1.id] },
      [planned.id]: { action: "unassign" },
    })
    expect(roster).toEqual([c1.id, c3.id])
    expect((await s.ledger.get("allocation", A, bought.id))?.recipientIds).toEqual([c1.id])
    expect((await s.ledger.get("allocation", A, planned.id))?.recipientIds).toEqual([c3.id])
    expect((await s.ledger.get("allocation", A, both.id))?.recipientIds).toEqual([c3.id])
  })

  it("keeps a bought gift on keep, archives an emptied one on unassign, and restores a re-added row", async () => {
    const s = setup()
    const [c1, c2] = (await s.people("C1", "C2")) as { id: string }[] as [
      { id: string },
      { id: string },
    ]
    const group = await s.ledger.create("group", meta, { name: "Two", memberIds: [c1.id, c2.id] })
    const xmas = await s.ledger.create("occasion", meta, christmas(2026, [group.id]))
    await s.sync(xmas)
    const idea = await s.ledger.create("item", meta, {
      title: "Scarf",
      url: null,
      productKey: null,
      variant: null,
      notes: null,
      source: { kind: "manual", ref: null },
      planning: "idea",
      estimateMinor: null,
      currency: null,
    })
    const alloc = (recipientIds: string[]) =>
      s.ledger.create("allocation", meta, {
        itemId: idea.id,
        occasionId: xmas.id,
        recipientIds,
        quantity: 1,
        shared: false,
        purchaseId: null,
        handoff: "none",
        givenOn: null,
      })
    const kept = await alloc([c2.id])
    const emptied = await alloc([c2.id])
    const g2 = await s.ledger.update("group", group.id, meta, group.revision, {
      memberIds: [c1.id],
    })
    await s.sync(xmas, {
      [kept.id]: { action: "keep" },
      [emptied.id]: { action: "unassign" },
    })
    expect((await s.ledger.get("allocation", A, kept.id))?.recipientIds).toEqual([c2.id])
    expect((await s.ledger.get("allocation", A, emptied.id))?.archived).toBe(true)
    await s.ledger.update("group", group.id, meta, g2.revision, { memberIds: [c1.id, c2.id] })
    expect(await s.sync(xmas)).toEqual([c1.id, c2.id])
    const rows = await s.ledger.list("occasionRecipient", A, {
      occasionId: xmas.id,
      includeArchived: true,
    })
    expect(rows.length).toBe(2)
  })
})
