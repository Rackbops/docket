import { describe, expect, it } from "vitest"

import {
  type GiftFieldsByKind,
  GiftLedger,
  type GiftOccasion,
  GiftRevisionError,
  GiftValidationError,
  type GiftWriteMeta,
  giftBuckets,
  giftCoverage,
  MemoryGiftStore,
  previewGiftRollover,
} from "../src/index.js"

const A = "owner-a"
const meta: GiftWriteMeta = { ownerId: A, actor: A, source: "web", at: "2026-12-30T12:00:00.000Z" }

const person = (name: string): GiftFieldsByKind["recipient"] => ({
  displayName: name,
  kind: "person",
  memberIds: [],
  labels: [],
  interests: [],
  avoid: [],
  notes: null,
})

const item = (title: string): GiftFieldsByKind["item"] => ({
  title,
  url: null,
  productKey: null,
  variant: null,
  notes: null,
  source: { kind: "manual", ref: null },
  planning: "selected",
  estimateMinor: 2500,
  currency: "USD",
})

const allocation = (
  itemId: string,
  occasionId: string,
  recipientIds: string[],
  extra: Partial<GiftFieldsByKind["allocation"]> = {},
): GiftFieldsByKind["allocation"] => ({
  itemId,
  occasionId,
  recipientIds,
  quantity: 1,
  shared: false,
  purchaseId: null,
  handoff: "none",
  givenOn: null,
  ...extra,
})

/**
 * Christmas 2026 for the Family group (Ann, Bob, Cy) plus Dee by hand: Ann's puzzle bought,
 * one of two returned (the return is on the given puzzle's purchase), and given; Bob's scarf an
 * unbought idea; a book on nobody (unassigned); Cy skipped.
 */
async function lastYear() {
  const store = new MemoryGiftStore()
  const ledger = new GiftLedger(store)
  const [ann, bob, cy, dee] = await Promise.all(
    ["Ann", "Bob", "Cy", "Dee"].map((n) => ledger.create("recipient", meta, person(n))),
  ).then((r) => r as [(typeof r)[0], (typeof r)[0], (typeof r)[0], (typeof r)[0]])
  const family = await ledger.create("group", meta, {
    name: "Family",
    memberIds: [ann.id, bob.id, cy.id],
  })
  const xmas = await ledger.create("occasion", meta, {
    kind: "christmas",
    title: "Christmas 2026",
    date: "2026-12-25",
    timeZone: null,
    year: 2026,
    currency: "USD",
    budgetMinor: 40000,
    groupIds: [family.id],
    includeIds: [dee.id],
    excludeIds: [],
  })
  const row = (recipientId: string, extra: Partial<GiftFieldsByKind["occasionRecipient"]> = {}) =>
    ledger.create("occasionRecipient", meta, {
      occasionId: xmas.id,
      recipientId,
      target: null,
      budgetMinor: null,
      decision: "planning",
      skipReason: null,
      ...extra,
    })
  await row(ann.id, { target: 1, budgetMinor: 5000, decision: "complete" })
  await row(bob.id)
  await row(cy.id, { decision: "skipped", skipReason: "away this year" })
  await row(dee.id)
  const puzzle = await ledger.create("item", meta, item("Puzzle"))
  const bought = await ledger.create("purchase", meta, {
    itemId: puzzle.id,
    merchant: "A shop",
    currency: "USD",
    unitPriceMinor: 2499,
    ordered: 2,
    received: 2,
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
  const given = await ledger.create(
    "allocation",
    meta,
    allocation(puzzle.id, xmas.id, [ann.id], {
      purchaseId: bought.id,
      handoff: "given",
      givenOn: "2026-12-25",
    }),
  )
  await ledger.update("purchase", bought.id, meta, bought.revision, { returned: 1 })
  const scarf = await ledger.create("item", meta, item("Scarf"))
  const idea = await ledger.create("allocation", meta, allocation(scarf.id, xmas.id, [bob.id]))
  await ledger.create("item", meta, item("Book"))
  const now = (await ledger.get("occasion", A, xmas.id)) as GiftOccasion
  await ledger.update("occasion", xmas.id, meta, now.revision, { archived: true })
  const old = (await ledger.get("occasion", A, xmas.id)) as GiftOccasion
  const all = { includeArchived: true }
  const read = async (occasion: GiftOccasion) => ({
    occasion,
    groups: await ledger.list("group", A, all),
    recipients: await ledger.list("recipient", A, all),
    roster: await ledger.list("occasionRecipient", A, { ...all, occasionId: occasion.id }),
    allocations: await ledger.list("allocation", A, all),
  })
  return { store, ledger, ann, bob, cy, dee, family, old, given, idea, read }
}

describe("setting up next year", () => {
  it("starts everyone at needs planning or planned, with no purchase carried", async () => {
    const s = await lastYear()
    const purchasesBefore = await s.ledger.list("purchase", A, { includeArchived: true })
    const preview = previewGiftRollover({ ...(await s.read(s.old)), pick: [s.idea.id] })
    expect(preview.occasion).toMatchObject({
      title: "Christmas 2027",
      date: "2027-12-25",
      year: 2027,
      budgetMinor: 40000,
    })
    expect(preview.roster.map((r) => r.recipientId)).toEqual([
      s.ann.id,
      s.bob.id,
      s.cy.id,
      s.dee.id,
    ])
    expect(preview.roster[0]).toEqual({
      recipientId: s.ann.id,
      target: 1,
      budgetMinor: 5000,
      carried: true,
    })
    expect(preview.pickable).toEqual([s.idea.id])

    const made = await s.ledger.applyGiftRollover(meta, preview)
    const rows = await s.ledger.list("occasionRecipient", A, { occasionId: made.id })
    const allocations = await s.ledger.list("allocation", A, { includeArchived: true })
    const purchases = await s.ledger.list("purchase", A, { includeArchived: true })
    const buckets = giftBuckets(allocations, purchases)
    expect(
      rows.map((r) => [r.recipientId, r.decision, r.skipReason, r.target, r.budgetMinor]),
    ).toEqual([
      [s.ann.id, "planning", null, 1, 5000],
      [s.bob.id, "planning", null, null, null],
      [s.cy.id, "planning", null, null, null],
      [s.dee.id, "planning", null, null, null],
    ])
    expect(rows.map((r) => giftCoverage(r, buckets).status)).toEqual([
      "needs-planning",
      "planned",
      "needs-planning",
      "needs-planning",
    ])
    const carried = allocations.filter((a) => a.occasionId === made.id)
    expect(carried).toHaveLength(1)
    expect(carried[0]).toMatchObject({
      itemId: s.idea.itemId,
      recipientIds: [s.bob.id],
      purchaseId: null,
      handoff: "none",
      givenOn: null,
    })
    expect(purchases).toEqual(purchasesBefore)
  })

  it("leaves the archived occasion and everything on it reading back unchanged", async () => {
    const s = await lastYear()
    const before = await s.read(s.old)
    const purchases = await s.ledger.list("purchase", A, { includeArchived: true })
    const oldIds = new Set([
      s.old.id,
      ...before.roster.map((r) => r.id),
      ...before.allocations.filter((a) => a.occasionId === s.old.id).map((a) => a.id),
      ...purchases.map((p) => p.id),
    ])
    const history = async () => (await s.store.listEvents(A)).filter((e) => oldIds.has(e.entityId))
    const historyBefore = await history()
    expect(historyBefore.length).toBeGreaterThan(0)
    await s.ledger.applyGiftRollover(meta, previewGiftRollover({ ...before, pick: [s.idea.id] }))
    expect(await history()).toEqual(historyBefore)
    const after = await s.read((await s.ledger.get("occasion", A, s.old.id)) as GiftOccasion)
    expect(after.occasion).toEqual(before.occasion)
    expect(after.roster).toEqual(before.roster)
    expect(after.allocations.filter((a) => a.occasionId === s.old.id)).toEqual(
      before.allocations.filter((a) => a.occasionId === s.old.id),
    )
    expect(await s.ledger.list("purchase", A, { includeArchived: true })).toEqual(purchases)
  })

  it("writes nothing for a preview that is never confirmed", async () => {
    const s = await lastYear()
    const events = (await s.store.listEvents(A)).length
    const occasions = await s.ledger.list("occasion", A, { includeArchived: true })
    previewGiftRollover({ ...(await s.read(s.old)), pick: [s.idea.id] })
    expect((await s.store.listEvents(A)).length).toBe(events)
    expect(await s.ledger.list("occasion", A, { includeArchived: true })).toEqual(occasions)
  })

  it("never carries a bought or given gift, and refuses to pick one", async () => {
    const s = await lastYear()
    const data = await s.read(s.old)
    expect(() => previewGiftRollover({ ...data, pick: [s.given.id] })).toThrow(
      `allocation ${s.given.id} was bought or handed off: it is never carried`,
    )
    expect(() => previewGiftRollover({ ...data, pick: [s.idea.id, s.idea.id] })).toThrow(
      GiftValidationError,
    )
  })

  it("never carries a bought gift not yet handed off, nor a wrapped one with no purchase", async () => {
    const s = await lastYear()
    const data = await s.read(s.old)
    const scarf = data.allocations.find((a) => a.id === s.idea.id)
    if (scarf === undefined) throw new Error("fixture")
    const bought = { ...scarf, id: "x-bought", purchaseId: "p-1" }
    const wrapped = { ...scarf, id: "x-wrapped", handoff: "wrapped" as const }
    const allocations = [...data.allocations, bought, wrapped]
    const p = previewGiftRollover({ ...data, allocations })
    expect(p.pickable).toEqual([s.idea.id])
    for (const id of ["x-bought", "x-wrapped"]) {
      expect(() => previewGiftRollover({ ...data, allocations, pick: [id] })).toThrow(
        `allocation ${id} was bought or handed off: it is never carried`,
      )
    }
  })

  it("re-resolves the groups against today's membership, and shows who is left off", async () => {
    const s = await lastYear()
    await s.ledger.update("group", s.family.id, meta, s.family.revision, {
      memberIds: [s.ann.id, s.cy.id],
    })
    const data = await s.read(s.old)
    const preview = previewGiftRollover({ ...data, pick: [] })
    expect(preview.roster.map((r) => r.recipientId)).toEqual([s.ann.id, s.cy.id, s.dee.id])
    expect(preview.leftOff).toEqual([s.bob.id])
    expect(() => previewGiftRollover({ ...data, pick: [s.idea.id] })).toThrow(
      "nobody it is for is on the new roster",
    )
  })

  it("refuses a preview the ledger moved on from, writing nothing, and replays a retried one", async () => {
    const s = await lastYear()
    const preview = previewGiftRollover({ ...(await s.read(s.old)), pick: [s.idea.id] })
    const b = (await s.ledger.get("recipient", A, s.bob.id)) as { revision: number }
    await s.ledger.update("recipient", s.bob.id, meta, b.revision, { archived: true })
    const events = (await s.store.listEvents(A)).length
    await expect(s.ledger.applyGiftRollover(meta, preview)).rejects.toBeInstanceOf(
      GiftRevisionError,
    )
    expect((await s.store.listEvents(A)).length).toBe(events)

    // A roster change alone (no pick touched) is refused too.
    const u = await lastYear()
    const q = previewGiftRollover({ ...(await u.read(u.old)) })
    await u.ledger.update("group", u.family.id, meta, u.family.revision, { memberIds: [u.ann.id] })
    await expect(u.ledger.applyGiftRollover(meta, q)).rejects.toBeInstanceOf(GiftRevisionError)
    expect(await u.ledger.list("occasion", A, { includeArchived: true })).toHaveLength(1)

    const t = await lastYear()
    const p = previewGiftRollover({ ...(await t.read(t.old)), pick: [t.idea.id] })
    const keyed = { ...meta, idempotencyKey: "roll-1" }
    const first = await t.ledger.applyGiftRollover(keyed, p)
    const again = await t.ledger.applyGiftRollover(keyed, p)
    expect(again.id).toBe(first.id)
    expect(await t.ledger.list("occasion", A, { includeArchived: true })).toHaveLength(2)
    const on = { includeArchived: true, occasionId: first.id }
    expect(await t.ledger.list("occasionRecipient", A, on)).toHaveLength(4)
    expect(await t.ledger.list("allocation", A, on)).toHaveLength(1)
  })

  it("refuses a second unkeyed apply instead of making the occasion twice", async () => {
    const s = await lastYear()
    const p = previewGiftRollover({ ...(await s.read(s.old)) })
    await s.ledger.applyGiftRollover(meta, p)
    await expect(s.ledger.applyGiftRollover(meta, p)).rejects.toBeInstanceOf(GiftValidationError)
    expect(await s.ledger.list("occasion", A, { includeArchived: true })).toHaveLength(2)
  })

  it("does not refuse for list order, key order or an unpicked gift bought since", async () => {
    const s = await lastYear()
    const data = await s.read(s.old)
    const shuffled = {
      ...data,
      groups: [...data.groups].reverse(),
      recipients: [...data.recipients].reverse(),
      roster: [...data.roster].reverse(),
      allocations: [...data.allocations].reverse(),
    }
    const p = previewGiftRollover({ ...shuffled, pick: [s.idea.id] })
    const reKeyed = JSON.parse(
      JSON.stringify(p, (_k, v) =>
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    )
    const book = (await s.ledger.list("item", A)).find((i) => i.title === "Book")
    if (book === undefined) throw new Error("fixture")
    await s.ledger.create("allocation", meta, allocation(book.id, s.old.id, [s.dee.id]))
    const made = await s.ledger.applyGiftRollover(meta, reKeyed)
    const on = { occasionId: made.id }
    expect(await s.ledger.list("occasionRecipient", A, on)).toHaveLength(4)
    expect(await s.ledger.list("allocation", A, on)).toHaveLength(1)
  })

  it("refuses a picked gift whose item was rejected since the preview", async () => {
    const s = await lastYear()
    const p = previewGiftRollover({ ...(await s.read(s.old)), pick: [s.idea.id] })
    const it0 = await s.ledger.get("item", A, s.idea.itemId)
    if (it0 === null) throw new Error("fixture")
    await s.ledger.update("item", it0.id, meta, it0.revision, { planning: "rejected" })
    const events = (await s.store.listEvents(A)).length
    await expect(s.ledger.applyGiftRollover(meta, p)).rejects.toBeInstanceOf(GiftRevisionError)
    expect((await s.store.listEvents(A)).length).toBe(events)
  })

  it("takes the year from an override date, and refuses a bad one at preview", async () => {
    const s = await lastYear()
    const data = await s.read(s.old)
    const p = previewGiftRollover({ ...data, title: "New Year 2028", date: "2028-01-02" })
    expect(p.occasion).toMatchObject({ title: "New Year 2028", date: "2028-01-02", year: 2028 })
    await s.ledger.applyGiftRollover(meta, p)
    expect(() => previewGiftRollover({ ...data, date: "2027-02-30" })).toThrow(GiftValidationError)
  })

  it("moves a 29 February date to the 28th, and keeps a title without the year", () => {
    const occasion = {
      id: "o1",
      ownerId: A,
      revision: 1,
      archived: false,
      createdAt: "",
      updatedAt: "",
      kind: "birthday",
      title: "Leap day party",
      date: "2028-02-29",
      timeZone: null,
      year: 2028,
      currency: "USD",
      budgetMinor: null,
      groupIds: [],
      includeIds: [],
      excludeIds: [],
    } as GiftOccasion
    const p = previewGiftRollover({
      occasion,
      groups: [],
      recipients: [],
      roster: [],
      allocations: [],
    })
    expect(p.occasion).toMatchObject({ title: "Leap day party", date: "2029-02-28", year: 2029 })
    const noYear = { ...occasion, title: "Party 2028", year: null } as GiftOccasion
    const q = previewGiftRollover({
      occasion: noYear,
      groups: [],
      recipients: [],
      roster: [],
      allocations: [],
    })
    expect(q.occasion).toMatchObject({ title: "Party 2029", date: "2029-02-28", year: null })
  })
})
