import { describe, expect, it } from "vitest"

import {
  editGroupMembers,
  type GiftAllocation,
  type GiftFieldsByKind,
  GiftLedger,
  type GiftOccasion,
  GiftRevisionError,
  GiftValidationError,
  type GiftWriteMeta,
  giftBuckets,
  groupMembers,
  MemoryGiftStore,
  occasionBudget,
  planGroupSync,
  previewGroupSync,
  previewRoster,
  resolveGroups,
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
      await ledger.list("recipient", A, { includeArchived: true }),
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

  it("a static group never depends on a label value", async () => {
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
    expect(() => previewGroupSync(archived, [group], [], [], [], [])).toThrow(GiftValidationError)
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

  it("leaves a gift untouched on keep, archives an emptied one on unassign, and restores a re-added row", async () => {
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
    const after = await s.ledger.get("allocation", A, kept.id)
    expect([after?.revision, after?.archived, after?.recipientIds]).toEqual([
      kept.revision,
      false,
      [c2.id],
    ])
    expect((await s.previewNow(xmas)).affected.map((a) => a.allocationId)).toEqual([kept.id])
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

describe("group sync edges", () => {
  const scarf: GiftFieldsByKind["item"] = {
    title: "Scarf",
    url: null,
    productKey: null,
    variant: null,
    notes: null,
    source: { kind: "manual", ref: null },
    planning: "idea",
    estimateMinor: null,
    currency: null,
  }

  /** Two people on a group-built Christmas, one scarf planned for the second. */
  async function pair() {
    const s = setup()
    const [c1, c2] = (await s.people("C1", "C2")) as { id: string }[] as [
      { id: string },
      { id: string },
    ]
    const group = await s.ledger.create("group", meta, { name: "Two", memberIds: [c1.id, c2.id] })
    const xmas = await s.ledger.create("occasion", meta, christmas(2026, [group.id]))
    await s.sync(xmas)
    const item = await s.ledger.create("item", meta, scarf)
    const gift = (recipientIds: string[], occasionId = xmas.id): Promise<GiftAllocation> =>
      s.ledger.create("allocation", meta, {
        itemId: item.id,
        occasionId,
        recipientIds,
        quantity: 1,
        shared: false,
        purchaseId: null,
        handoff: "none",
        givenOn: null,
      })
    return { s, c1, c2, group, xmas, gift }
  }

  it("refuses an occasion naming a missing or wrong-kind group or person", async () => {
    const { s, c1, group } = await pair()
    await expect(s.ledger.create("occasion", meta, christmas(2030, [c1.id]))).rejects.toThrow(
      `no group ${c1.id}`,
    )
    await expect(
      s.ledger.create("occasion", meta, christmas(2030, [], [group.id])),
    ).rejects.toThrow(`no recipient ${group.id}`)
    await expect(
      s.ledger.create("occasion", meta, christmas(2030, [], [], [group.id])),
    ).rejects.toThrow(`no recipient ${group.id}`)
    const other = { ...meta, ownerId: "owner-b", actor: "owner-b" }
    await expect(s.ledger.create("occasion", other, christmas(2030, [group.id]))).rejects.toThrow(
      `no group ${group.id}`,
    )
    for (const field of ["groupIds", "includeIds", "excludeIds"]) {
      await expect(
        s.ledger.create("occasion", meta, { ...christmas(2030, []), [field]: [c1.id, c1.id] }),
      ).rejects.toThrow("repeats an id")
      await expect(
        s.ledger.create("occasion", meta, { ...christmas(2030, []), [field]: "x" } as never),
      ).rejects.toThrow("must be a list of ids")
    }
  })

  it("refuses a preview whose groups were not all given", async () => {
    const { s, xmas } = await pair()
    expect(() => previewGroupSync(xmas, [], [], [], [], [])).toThrow(
      `occasion names group ${xmas.groupIds[0]}, not given`,
    )
    expect(await s.liveRoster(xmas.id)).toHaveLength(2)
  })

  it("asks about every live gift on this occasion naming someone off the roster, and only those", async () => {
    const { s, c1, c2, group, xmas, gift } = await pair()
    const easter = await s.ledger.create("occasion", meta, {
      ...christmas(2027, []),
      includeIds: [c2.id],
    })
    const asked = await gift([c1.id, c2.id])
    const gone = await gift([c2.id])
    await s.ledger.update("allocation", gone.id, meta, gone.revision, { archived: true })
    await gift([c2.id], easter.id)
    await gift([c1.id])
    await s.ledger.update("group", group.id, meta, group.revision, { memberIds: [c1.id] })
    const preview = await s.previewNow(xmas)
    expect(preview.affected.map((a) => [a.allocationId, a.dropped])).toEqual([[asked.id, [c2.id]]])
  })

  it("still asks about a gift whose recipient's row went in an earlier sync", async () => {
    const { s, c1, c2, group, xmas, gift } = await pair()
    const g = await gift([c2.id])
    await s.ledger.update("group", group.id, meta, group.revision, { memberIds: [c1.id] })
    const row = (await s.ledger.list("occasionRecipient", A, { occasionId: xmas.id })).find(
      (r) => r.recipientId === c2.id,
    ) as { id: string; revision: number }
    await s.ledger.update("occasionRecipient", row.id, meta, row.revision, { archived: true })
    const preview = await s.previewNow(xmas)
    expect([preview.removed, preview.affected.map((a) => a.allocationId)]).toEqual([[], [g.id]])
  })

  it("writes gifts before rows, so a refused gift write leaves the roster as it was", async () => {
    const { s, c1, c2, group, xmas, gift } = await pair()
    const g = await gift([c2.id])
    await s.ledger.update("group", group.id, meta, group.revision, { memberIds: [c1.id] })
    const preview = await s.previewNow(xmas)
    const plan = planGroupSync(preview, { [g.id]: { action: "unassign" } })
    await s.ledger.update("allocation", g.id, meta, g.revision, { quantity: 2 })
    await expect(s.ledger.applyGiftSync(meta, plan)).rejects.toThrow(GiftRevisionError)
    expect(await s.liveRoster(xmas.id)).toEqual([c1.id, c2.id])
    expect((await s.previewNow(xmas)).affected.map((a) => a.allocationId)).toEqual([g.id])
  })

  it("refuses reassigning to nobody or to someone off the roster, and decisions for other gifts", async () => {
    const { s, c1, c2, group, xmas, gift } = await pair()
    const g = await gift([c2.id])
    const other = await gift([c1.id])
    await s.ledger.update("group", group.id, meta, group.revision, { memberIds: [c1.id] })
    const preview = await s.previewNow(xmas)
    expect(() =>
      planGroupSync(preview, { [g.id]: { action: "reassign", recipientIds: [] } }),
    ).toThrow("reassign names nobody")
    expect(() =>
      planGroupSync(preview, { [g.id]: { action: "reassign", recipientIds: [c1.id, c1.id] } }),
    ).toThrow("reassign repeats a recipient")
    expect(() =>
      planGroupSync(preview, { [g.id]: { action: "reassign", recipientIds: [c2.id] } }),
    ).toThrow(`${c2.id} will not be on the roster`)
    expect(() =>
      planGroupSync(preview, {
        [g.id]: { action: "keep" },
        [other.id]: { action: "unassign" },
      }),
    ).toThrow(`allocation ${other.id} is not affected by this sync`)
  })

  it("refuses a plan when the occasion or a group moved or the occasion was archived", async () => {
    const { s, c1, c2, group, xmas } = await pair()
    const g2 = await s.ledger.update("group", group.id, meta, group.revision, {
      memberIds: [c1.id],
    })
    const plan = planGroupSync(await s.previewNow(xmas), {})
    await s.ledger.update("group", group.id, meta, g2.revision, { name: "Renamed" })
    await expect(s.ledger.applyGiftSync(meta, plan)).rejects.toThrow(`group ${group.id}`)
    const fresh = planGroupSync(await s.previewNow(xmas), {})
    await s.ledger.update("occasion", xmas.id, meta, xmas.revision, { title: "Xmas" })
    await expect(s.ledger.applyGiftSync(meta, fresh)).rejects.toThrow(`occasion ${xmas.id}`)
    const now = (await s.ledger.get("occasion", A, xmas.id)) as GiftOccasion
    const last = planGroupSync(await s.previewNow(now), {})
    await s.ledger.update("occasion", xmas.id, meta, now.revision, { archived: true })
    await expect(s.ledger.applyGiftSync(meta, last)).rejects.toThrow("never synced")
    expect(await s.liveRoster(xmas.id)).toEqual([c1.id, c2.id])
  })

  it("replays a retried plan with the same key, one write per step", async () => {
    const s = setup()
    const [a, b] = (await s.people("A", "B")) as { id: string }[] as [
      { id: string },
      { id: string },
    ]
    const group = await s.ledger.create("group", meta, { name: "G", memberIds: [a.id, b.id] })
    const xmas = await s.ledger.create("occasion", meta, christmas(2026, [group.id]))
    const plan = planGroupSync(await s.previewNow(xmas), {})
    const keyed = { ...meta, idempotencyKey: "sync-1" }
    await s.ledger.applyGiftSync(keyed, plan)
    await s.ledger.applyGiftSync(keyed, plan)
    expect(await s.liveRoster(xmas.id)).toEqual([a.id, b.id])
    expect(
      await s.ledger.list("occasionRecipient", A, { occasionId: xmas.id, includeArchived: true }),
    ).toHaveLength(2)
  })

  it("previews coverage and budget for people added and removed", async () => {
    const { s, c1, c2, group, xmas, gift } = await pair()
    const rows = await s.ledger.list("occasionRecipient", A, { occasionId: xmas.id })
    for (const [r, budgetMinor] of rows.map((r, i) => [r, [2000, 3000][i]] as const)) {
      await s.ledger.update("occasionRecipient", r.id, meta, r.revision, { budgetMinor })
    }
    const [c3] = (await s.people("C3")) as { id: string }[]
    const g1 = await s.ledger.update("group", group.id, meta, group.revision, {
      memberIds: [c2.id],
    })
    await s.sync(xmas)
    expect(
      occasionBudget(
        xmas,
        await s.ledger.list("occasionRecipient", A, {
          occasionId: xmas.id,
          includeArchived: true,
        }),
      ),
    ).toEqual({ currency: "USD", budgetMinor: 50000, recipientBudgetsMinor: 3000, recipients: 1 })
    await gift([c1.id])
    await s.ledger.update("group", group.id, meta, g1.revision, {
      memberIds: [c1.id, (c3 as { id: string }).id],
    })
    const preview = await s.previewNow(xmas)
    expect(
      preview.added.map((a) => [a.recipientId, a.restore?.budgetMinor ?? null, a.coverage.status]),
    ).toEqual([
      [c1.id, 2000, "planned"],
      [(c3 as { id: string }).id, null, "needs-planning"],
    ])
    expect(preview.removed.map((r) => r.row.recipientId)).toEqual([c2.id])
    expect(preview.budgetDeltaMinor).toBe(2000 - 3000)
    expect(preview.roster).toEqual([c1.id, (c3 as { id: string }).id])
  })

  it("a sync that changes no budget reports 0, not -0", async () => {
    const { s, c1, group, xmas } = await pair()
    await s.ledger.update("group", group.id, meta, group.revision, { memberIds: [c1.id] })
    expect((await s.previewNow(xmas)).budgetDeltaMinor).toBe(0)
  })
})

describe("filter groups (docket#98)", () => {
  const relabel = async (s: ReturnType<typeof setup>, id: string, labels: string[]) => {
    const r = (await s.ledger.get("recipient", A, id)) as { revision: number }
    return s.ledger.update("recipient", id, meta, r.revision, { labels })
  }

  it("leaves out a person whose label is blank, and includes them once the owner adds it", async () => {
    const s = setup()
    const [ann, bob, cy] = (await s.people("Ann", "Bob", "Cy")) as { id: string }[] as [
      { id: string },
      { id: string },
      { id: string },
    ]
    await relabel(s, ann.id, ["Cousin", " adult "])
    await relabel(s, cy.id, ["cousin", "child"])
    const g = await s.ledger.create("group", meta, {
      name: "Adult cousins",
      memberIds: [],
      filter: { labels: ["cousin", "Adult"] },
    })
    const members = async () =>
      groupMembers(g, await s.ledger.list("recipient", A, { includeArchived: true }))
    expect(await members()).toEqual([ann.id])
    // Bob has no labels at all: a name never stands in for one.
    await relabel(s, bob.id, ["cousin", "adult"])
    expect(await members()).toEqual([ann.id, bob.id])
    // An archived recipient is no longer matched.
    const b = (await s.ledger.get("recipient", A, bob.id)) as { revision: number }
    await s.ledger.update("recipient", bob.id, meta, b.revision, { archived: true })
    expect(await members()).toEqual([ann.id])
  })

  it("never matches a blank label, and refuses a filter that would", async () => {
    expect(
      groupMembers({ ownerId: A, memberIds: [], filter: { labels: [" "] } }, [
        { id: "r1", ownerId: A, archived: false, labels: [" "] } as never,
      ]),
    ).toEqual([])
    const s = setup()
    await expect(
      s.ledger.create("group", meta, { name: "x", memberIds: [], filter: { labels: [""] } }),
    ).rejects.toThrow("filter labels must be 1 to")
    await expect(
      s.ledger.create("group", meta, { name: "x", memberIds: [], filter: { labels: [] } }),
    ).rejects.toThrow("filter needs at least 1 label")
    const [ann] = (await s.people("Ann")) as { id: string }[] as [{ id: string }]
    await expect(
      s.ledger.create("group", meta, {
        name: "x",
        memberIds: [ann.id],
        filter: { labels: ["cousin"] },
      }),
    ).rejects.toThrow("a filter group has no memberIds")
    await expect(
      s.ledger.create("group", meta, {
        name: "x",
        memberIds: [],
        filter: { labels: ["cousin"], name: "Ann" } as never,
      }),
    ).rejects.toThrow("filter takes only labels, not name")
  })

  it("keeps a group made without a filter working, as before docket#98", async () => {
    const s = setup()
    const [ann] = (await s.people("Ann")) as { id: string }[] as [{ id: string }]
    const g = await s.ledger.create("group", meta, { name: "Old", memberIds: [ann.id] })
    expect("filter" in g).toBe(false)
    const renamed = await s.ledger.update("group", g.id, meta, g.revision, { name: "Older" })
    expect(renamed).toMatchObject({ name: "Older", memberIds: [ann.id] })
    expect(groupMembers(renamed, [])).toEqual([ann.id])
  })

  it("refuses a filter group passed to previewRoster unresolved, never reading it as empty", async () => {
    expect(() =>
      previewRoster([{ id: "g1", memberIds: [], filter: { labels: ["cousin"] } }], [], []),
    ).toThrow("group g1 is a filter group: resolve it with resolveGroups first")
  })

  it("previews exactly the roster the occasion then snapshots, and the snapshot stays put", async () => {
    const s = setup()
    const [ann, bob, cy, dee] = (await s.people("Ann", "Bob", "Cy", "Dee")) as {
      id: string
    }[] as [{ id: string }, { id: string }, { id: string }, { id: string }]
    await relabel(s, ann.id, ["cousin"])
    await relabel(s, bob.id, ["cousin"])
    const g = await s.ledger.create("group", meta, {
      name: "Cousins",
      memberIds: [],
      filter: { labels: ["cousin"] },
    })
    const recipients = await s.ledger.list("recipient", A, { includeArchived: true })
    const shown = rosterIds(previewRoster(resolveGroups([g], recipients), [cy.id], [bob.id]))
    const xmas = await s.ledger.create("occasion", meta, christmas(2026, [g.id], [cy.id], [bob.id]))
    expect((await s.previewNow(xmas)).roster).toEqual(shown)
    expect(await s.sync(xmas)).toEqual(shown)
    expect(shown).toEqual([ann.id, cy.id])
    // A label added or taken away later changes nothing on the occasion until it is synced again.
    await relabel(s, dee.id, ["cousin"])
    await relabel(s, ann.id, [])
    expect(await s.liveRoster(xmas.id)).toEqual([ann.id, cy.id])
    expect((await s.previewNow(xmas)).roster).toEqual([dee.id, cy.id])
  })

  it("refuses to apply a sync when a label moved the filter's matches after the preview", async () => {
    const s = setup()
    const [ann, bob] = (await s.people("Ann", "Bob")) as { id: string }[] as [
      { id: string },
      { id: string },
    ]
    await relabel(s, ann.id, ["cousin"])
    const g = await s.ledger.create("group", meta, {
      name: "Cousins",
      memberIds: [],
      filter: { labels: ["cousin"] },
    })
    const xmas = await s.ledger.create("occasion", meta, christmas(2026, [g.id]))
    const plan = planGroupSync(await s.previewNow(xmas), {})
    await relabel(s, bob.id, ["cousin"])
    await expect(s.ledger.applyGiftSync(meta, plan)).rejects.toBeInstanceOf(GiftRevisionError)
    expect(await s.liveRoster(xmas.id)).toEqual([])
    expect(await s.sync(xmas)).toEqual([ann.id, bob.id])
  })
})

describe("filter groups beside static ones", () => {
  it("applies a sync whose occasion picks the groups in another order than they were made", async () => {
    const s = setup()
    const [ann, bob] = (await s.people("Ann", "Bob")) as { id: string }[] as [
      { id: string },
      { id: string },
    ]
    const r = (await s.ledger.get("recipient", A, ann.id)) as { revision: number }
    await s.ledger.update("recipient", ann.id, meta, r.revision, { labels: ["cousin"] })
    const cousins = await s.ledger.create("group", meta, {
      name: "Cousins",
      memberIds: [],
      filter: { labels: ["cousin"] },
    })
    const friends = await s.ledger.create("group", meta, { name: "Friends", memberIds: [bob.id] })
    const xmas = await s.ledger.create("occasion", meta, christmas(2026, [friends.id, cousins.id]))
    const preview = await s.previewNow(xmas)
    expect(preview.roster).toEqual([bob.id, ann.id])
    await s.ledger.applyGiftSync(meta, planGroupSync(preview, {}))
    expect(await s.liveRoster(xmas.id)).toEqual([bob.id, ann.id])
  })

  it("matches nothing when a filter carries a blank label, and has no list to edit", () => {
    const ann = { id: "r1", ownerId: A, archived: false, labels: ["a"] } as never
    expect(
      groupMembers({ ownerId: A, memberIds: [], filter: { labels: ["a", " "] } }, [ann]),
    ).toEqual([])
    expect(groupMembers({ ownerId: A, memberIds: [], filter: { labels: ["A "] } }, [ann])).toEqual([
      "r1",
    ])
    expect(() =>
      editGroupMembers({ memberIds: [], filter: { labels: ["a"] } }, ["r1"], []),
    ).toThrow("a filter group has no list to edit")
  })

  it("refuses a filter that repeats a label", async () => {
    const s = setup()
    await expect(
      s.ledger.create("group", meta, {
        name: "x",
        memberIds: [],
        filter: { labels: ["Cousin", "cousin "] },
      }),
    ).rejects.toThrow("filter labels repeats a label")
  })
})
