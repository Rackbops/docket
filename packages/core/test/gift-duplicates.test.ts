import { describe, expect, it } from "vitest"

import {
  compareGiftItems,
  type GiftFieldsByKind,
  GiftLedger,
  GiftNotFoundError,
  GiftValidationError,
  type GiftWriteMeta,
  giftUrlKey,
  MemoryGiftStore,
} from "../src/index.js"

const A = "owner-a"
const meta: GiftWriteMeta = { ownerId: A, actor: A, source: "web", at: "2026-11-13T12:00:00.000Z" }

const person = (name: string): GiftFieldsByKind["recipient"] => ({
  displayName: name,
  kind: "person",
  memberIds: [],
  labels: [],
  interests: [],
  avoid: [],
  notes: null,
})

const item = (
  title: string,
  extra: Partial<GiftFieldsByKind["item"]> = {},
): GiftFieldsByKind["item"] => ({
  title,
  url: null,
  productKey: null,
  variant: null,
  notes: null,
  source: { kind: "manual", ref: null },
  planning: "selected",
  estimateMinor: null,
  currency: null,
  ...extra,
})

const occasion = (
  kind: GiftFieldsByKind["occasion"]["kind"],
  title: string,
): GiftFieldsByKind["occasion"] => ({
  kind,
  title,
  date: null,
  timeZone: null,
  year: null,
  currency: "USD",
  budgetMinor: null,
  groupIds: [],
  includeIds: [],
  excludeIds: [],
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

const URL1 = "https://www.example.com/p/lego-castle/?utm_source=mail#reviews"

async function setup() {
  const store = new MemoryGiftStore()
  const ledger = new GiftLedger(store)
  const ann = await ledger.create("recipient", meta, person("Ann"))
  const bob = await ledger.create("recipient", meta, person("Bob"))
  const xmas = await ledger.create("occasion", meta, occasion("christmas", "Christmas"))
  const bday = await ledger.create("occasion", meta, occasion("birthday", "Ann's birthday"))
  return { store, ledger, ann, bob, xmas, bday }
}

describe("duplicate gift warnings", () => {
  it("warns on the same URL for one person at Christmas and her birthday; accepting records the repeat", async () => {
    const s = await setup()
    const castle = await s.ledger.create("item", meta, item("Lego castle", { url: URL1 }))
    const again = await s.ledger.create(
      "item",
      meta,
      item("Castle set", { url: "http://example.com/p/lego-castle" }),
    )
    const first = await s.ledger.create(
      "allocation",
      meta,
      allocation(castle.id, s.xmas.id, [s.ann.id]),
    )
    const next = { itemId: again.id, occasionId: s.bday.id, recipientIds: [s.ann.id] }
    const report = await s.ledger.giftDuplicates(A, next)
    expect(report.possible).toEqual([])
    expect(report.warnings).toEqual([
      {
        allocationId: first.id,
        itemId: castle.id,
        occasionId: s.xmas.id,
        recipientIds: [s.ann.id],
        where: "open",
        match: "url",
        accepted: false,
      },
    ])

    // The owner says yes: the allocation is written, with the warning it accepted.
    const made = await s.ledger.create("allocation", meta, {
      ...allocation(again.id, s.bday.id, [s.ann.id]),
      repeatOf: [first.id],
    })
    expect((await s.ledger.get("allocation", A, made.id))?.repeatOf).toEqual([first.id])
    const events = await s.ledger.history(A, { entityId: made.id })
    expect(events.map((e) => (e.next as { repeatOf?: unknown }).repeatOf)).toEqual([[first.id]])
    const asked = await s.ledger.giftDuplicates(A, {
      ...next,
      id: made.id,
      repeatOf: made.repeatOf,
    })
    expect(asked.warnings.map((w) => [w.allocationId, w.accepted])).toEqual([[first.id, true]])
  })

  it("gives no warning for the same URL for two different people", async () => {
    const s = await setup()
    const castle = await s.ledger.create("item", meta, item("Lego castle", { url: URL1 }))
    await s.ledger.create("allocation", meta, allocation(castle.id, s.xmas.id, [s.ann.id]))
    const report = await s.ledger.giftDuplicates(A, {
      itemId: castle.id,
      occasionId: s.bday.id,
      recipientIds: [s.bob.id],
    })
    expect(report).toEqual({ warnings: [], possible: [] })
  })

  it("offers two variants of one product as a possible duplicate, not a warning", async () => {
    const s = await setup()
    const blue = await s.ledger.create(
      "item",
      meta,
      item("Scarf", { productKey: "acme-scarf-01", variant: "Blue" }),
    )
    const red = await s.ledger.create(
      "item",
      meta,
      item("Scarf in red", { productKey: "ACME-scarf-01 ", variant: "Red" }),
    )
    const first = await s.ledger.create(
      "allocation",
      meta,
      allocation(blue.id, s.xmas.id, [s.ann.id]),
    )
    const report = await s.ledger.giftDuplicates(A, {
      itemId: red.id,
      occasionId: s.bday.id,
      recipientIds: [s.ann.id],
    })
    expect(report.warnings).toEqual([])
    expect(report.possible.map((p) => [p.allocationId, p.match])).toEqual([[first.id, "variant"]])
  })

  it("warns on their history: given, or bought on an archived occasion, but not taken back", async () => {
    const s = await setup()
    const book = await s.ledger.create("item", meta, item("Book", { productKey: "isbn-1" }))
    const copy = await s.ledger.create("item", meta, item("Book again", { productKey: "isbn-1" }))
    const bought = await s.ledger.create("purchase", meta, {
      itemId: book.id,
      merchant: null,
      currency: "USD",
      unitPriceMinor: 1000,
      ordered: 3,
      received: 3,
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
    const last = await s.ledger.create("occasion", meta, occasion("christmas", "Christmas 2025"))
    const easter = await s.ledger.create("occasion", meta, occasion("custom", "Easter"))
    const given = await s.ledger.create(
      "allocation",
      meta,
      allocation(book.id, s.xmas.id, [s.ann.id], {
        purchaseId: bought.id,
        handoff: "given",
        givenOn: "2026-01-01",
      }),
    )
    const boughtThen = await s.ledger.create(
      "allocation",
      meta,
      allocation(book.id, last.id, [s.ann.id], { purchaseId: bought.id }),
    )
    const takenBack = await s.ledger.create(
      "allocation",
      meta,
      allocation(book.id, easter.id, [s.ann.id], { purchaseId: bought.id }),
    )
    await s.ledger.update("allocation", takenBack.id, meta, takenBack.revision, { archived: true })
    await s.ledger.update("occasion", last.id, meta, last.revision, { archived: true })
    const g = await s.ledger.get("allocation", A, given.id)
    if (g === null) throw new Error("fixture")
    await s.ledger.update("allocation", given.id, meta, g.revision, { archived: true })
    const report = await s.ledger.giftDuplicates(A, {
      itemId: copy.id,
      occasionId: s.bday.id,
      recipientIds: [s.ann.id],
    })
    expect(report.warnings.map((w) => [w.allocationId, w.where, w.match])).toEqual([
      [given.id, "history", "productKey"],
      [boughtThen.id, "history", "productKey"],
    ])
  })

  it("leaves out the same occasion, an unbought idea on an archived one, and anything never allocated", async () => {
    const s = await setup()
    const castle = await s.ledger.create("item", meta, item("Lego castle", { url: URL1 }))
    // A scout finding a watch saw: an item, never allocated, so nobody owns it.
    const seen = await s.ledger.create(
      "item",
      meta,
      item("Lego castle", { url: URL1, source: { kind: "scout", ref: "t1/f1" } }),
    )
    await s.ledger.create("allocation", meta, allocation(castle.id, s.xmas.id, [s.ann.id]))
    const old = await s.ledger.create("occasion", meta, occasion("custom", "Old"))
    await s.ledger.create("allocation", meta, allocation(castle.id, old.id, [s.ann.id]))
    await s.ledger.update("occasion", old.id, meta, old.revision, { archived: true })
    const report = await s.ledger.giftDuplicates(A, {
      itemId: castle.id,
      occasionId: s.xmas.id,
      recipientIds: [s.ann.id],
    })
    expect(report).toEqual({ warnings: [], possible: [] })
    // Bob has nothing allocated: the seen listing, and Ann's castle, are not his.
    const bobs = await s.ledger.giftDuplicates(A, {
      itemId: seen.id,
      occasionId: s.bday.id,
      recipientIds: [s.bob.id],
    })
    expect(bobs).toEqual({ warnings: [], possible: [] })
  })

  it("leaves out a dropped idea on a live occasion, and a bought gift returned since", async () => {
    const s = await setup()
    const url = "https://example.com/kite"
    const kite = await s.ledger.create("item", meta, item("Kite", { url, planning: "rejected" }))
    const again = await s.ledger.create("item", meta, item("Kite", { url }))
    await s.ledger.create("allocation", meta, allocation(kite.id, s.xmas.id, [s.ann.id]))
    const p = await s.ledger.create("purchase", meta, {
      itemId: again.id,
      merchant: null,
      currency: "USD",
      unitPriceMinor: 1000,
      ordered: 1,
      received: 1,
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
    const old = await s.ledger.create("occasion", meta, occasion("custom", "Old"))
    const bought = await s.ledger.create(
      "allocation",
      meta,
      allocation(again.id, old.id, [s.ann.id], { purchaseId: p.id }),
    )
    await s.ledger.update("occasion", old.id, meta, old.revision, { archived: true })
    const ask = { itemId: again.id, occasionId: s.bday.id, recipientIds: [s.ann.id] }
    expect((await s.ledger.giftDuplicates(A, ask)).warnings.map((w) => w.allocationId)).toEqual([
      bought.id,
    ])
    await s.ledger.update("purchase", p.id, meta, p.revision, { returned: 1 })
    expect(await s.ledger.giftDuplicates(A, ask)).toEqual({ warnings: [], possible: [] })
  })

  it("matches a household and its member both ways", async () => {
    const s = await setup()
    const home = await s.ledger.create("recipient", meta, {
      ...person("The Smiths"),
      kind: "household",
      memberIds: [s.ann.id],
    })
    const game = await s.ledger.create("item", meta, item("Board game", { productKey: "bg-1" }))
    const toHome = await s.ledger.create(
      "allocation",
      meta,
      allocation(game.id, s.xmas.id, [home.id]),
    )
    const forAnn = await s.ledger.giftDuplicates(A, {
      itemId: game.id,
      occasionId: s.bday.id,
      recipientIds: [s.ann.id],
    })
    expect(forAnn.warnings.map((w) => [w.allocationId, w.recipientIds])).toEqual([
      [toHome.id, [s.ann.id]],
    ])
    const toAnn = await s.ledger.create(
      "allocation",
      meta,
      allocation(game.id, s.bday.id, [s.ann.id]),
    )
    const other = await s.ledger.create("occasion", meta, occasion("custom", "Party"))
    const forHome = await s.ledger.giftDuplicates(A, {
      itemId: game.id,
      occasionId: other.id,
      recipientIds: [home.id, s.bob.id],
    })
    expect(forHome.warnings.map((w) => [w.allocationId, w.recipientIds])).toEqual([
      [toHome.id, [home.id]],
      [toAnn.id, [home.id]],
    ])
  })

  it("refuses an item that is not the owner's, and accepts an empty repeatOf", async () => {
    const s = await setup()
    await expect(
      s.ledger.giftDuplicates(A, { itemId: "nope", occasionId: s.xmas.id, recipientIds: [] }),
    ).rejects.toBeInstanceOf(GiftNotFoundError)
    const castle = await s.ledger.create("item", meta, item("Lego castle"))
    const made = await s.ledger.create("allocation", meta, {
      ...allocation(castle.id, s.xmas.id, [s.ann.id]),
      repeatOf: [],
    })
    expect(made.repeatOf).toEqual([])
  })

  it("refuses a repeatOf naming itself or an allocation that is not the owner's", async () => {
    const s = await setup()
    const castle = await s.ledger.create("item", meta, item("Lego castle"))
    const a = await s.ledger.create(
      "allocation",
      meta,
      allocation(castle.id, s.xmas.id, [s.ann.id]),
    )
    await expect(
      s.ledger.update("allocation", a.id, meta, a.revision, { repeatOf: [a.id] }),
    ).rejects.toBeInstanceOf(GiftValidationError)
    await expect(
      s.ledger.create("allocation", meta, {
        ...allocation(castle.id, s.bday.id, [s.ann.id]),
        repeatOf: ["no-such-allocation"],
      }),
    ).rejects.toBeInstanceOf(GiftNotFoundError)
  })
})

describe("comparing gifts", () => {
  it("normalizes a URL: scheme, www, trailing slash, fragment and tracking parameters", () => {
    expect(giftUrlKey(URL1)).toBe("example.com/p/lego-castle")
    expect(giftUrlKey("https://shop.example/x?b=2&a=1&gclid=z")).toBe("shop.example/x?a=1&b=2")
    expect(giftUrlKey("https://M.Example.com/P")).toBe("example.com/P")
    for (const notWeb of ["not a url", "n/a", "/relative/Path", "mailto:a@example.com", null]) {
      expect(giftUrlKey(notWeb)).toBeNull()
    }
  })

  it("keeps a product key ahead of the URL, and offers a page or a title as possible", () => {
    const base = { title: "Scarf", url: null, productKey: null, variant: null }
    expect(
      compareGiftItems(
        { ...base, productKey: "k1", url: "https://a.example/s" },
        { ...base, productKey: "k2", url: "https://a.example/s" },
      ),
    ).toEqual({ possible: "page" })
    expect(
      compareGiftItems(
        { ...base, url: "https://a.example/s?variant=1" },
        { ...base, url: "https://a.example/s?variant=2" },
      ),
    ).toEqual({ possible: "page" })
    expect(
      compareGiftItems({ ...base, title: "Wool scarf!" }, { ...base, title: "wool  SCARF" }),
    ).toEqual({ possible: "title" })
    expect(compareGiftItems({ ...base, title: "Scarf" }, { ...base, title: "Hat" })).toBeNull()
    // A placeholder in the URL field never makes two different gifts one product.
    expect(
      compareGiftItems(
        { ...base, title: "Lego", url: "n/a" },
        { ...base, title: "Socks", url: "N/A" },
      ),
    ).toBeNull()
  })
})
