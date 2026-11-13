import { describe, expect, it } from "vitest"

import {
  decideGiftDigest,
  GIFT_DIGEST_NAMES_MAX,
  type GiftDigestInput,
  type GiftDigestState,
  GiftLedger,
  type GiftWriteMeta,
  giftBuckets,
  giftDigestKey,
  giftProblems,
  MemoryGiftStore,
  previewGiftRollover,
} from "../src/index.js"

const T0 = "2026-11-13T12:00:00.000Z"
const meta: GiftWriteMeta = { ownerId: "u1", actor: "u1", source: "web", at: T0 }
const owner = { timeZone: "America/New_York", preferredHour: 9 }

/** 10:00 in New York on the given day (UTC-5 in winter). */
const at = (day: string, hour = 10) =>
  new Date(`${day}T${String(hour + 5).padStart(2, "0")}:00:00Z`)

async function world(occasion: { digest?: boolean | null; deadline?: string | null } = {}) {
  const ledger = new GiftLedger(new MemoryGiftStore())
  const person = (displayName: string) =>
    ledger.create("recipient", meta, {
      displayName,
      kind: "person",
      memberIds: [],
      labels: [],
      interests: [],
      avoid: [],
      notes: "private note about them",
    })
  const ann = await person("Ann")
  const bo = await person("Bo")
  const xmas = await ledger.create("occasion", meta, {
    kind: "christmas",
    title: "Christmas 2026",
    date: "2026-12-25",
    timeZone: null,
    year: 2026,
    currency: "USD",
    budgetMinor: 50000,
    groupIds: [],
    includeIds: [],
    excludeIds: [],
    digest: true,
    deadline: "2026-12-18",
    ...occasion,
  })
  for (const r of [ann, bo]) {
    await ledger.create("occasionRecipient", meta, {
      occasionId: xmas.id,
      recipientId: r.id,
      target: null,
      budgetMinor: 4000,
      decision: "planning",
      skipReason: null,
    })
  }
  const item = await ledger.create("item", meta, {
    title: "Lighthouse puzzle",
    url: null,
    productKey: null,
    variant: null,
    notes: "hide it in the closet",
    source: { kind: "manual", ref: null },
    planning: "selected",
    estimateMinor: 2499,
    currency: "USD",
  })
  const purchase = await ledger.create("purchase", meta, {
    itemId: item.id,
    merchant: "Puzzle Shop",
    currency: "USD",
    unitPriceMinor: 2499,
    ordered: 1,
    received: 0,
    cancelled: 0,
    returned: 0,
    taxMinor: 0,
    shippingMinor: 0,
    discountMinor: 0,
    totalComplete: true,
    refundedMinor: 0,
    purchasedOn: "2026-11-10",
    reference: null,
  })
  await ledger.create("allocation", meta, {
    itemId: item.id,
    occasionId: xmas.id,
    recipientIds: [ann.id],
    quantity: 1,
    shared: false,
    purchaseId: purchase.id,
    handoff: "none",
    givenOn: null,
  })
  const input = async (now: Date, last: GiftDigestState | null): Promise<GiftDigestInput> => {
    const all = { includeArchived: true }
    return {
      occasion: (await ledger.get("occasion", "u1", xmas.id)) ?? xmas,
      roster: await ledger.list("occasionRecipient", "u1"),
      buckets: giftBuckets(
        await ledger.list("allocation", "u1", all),
        await ledger.list("purchase", "u1", all),
      ),
      recipients: await ledger.list("recipient", "u1", all),
      owner,
      now,
      last,
    }
  }
  return { ledger, ann, bo, xmas, item, purchase, input }
}

describe("decideGiftDigest", () => {
  it("names who still needs a gift and counts what is on its way", async () => {
    const w = await world()
    const d = decideGiftDigest(await w.input(at("2026-12-01"), null))
    expect(d).toMatchObject({ due: true, daysLeft: 17 })
    if (!d.due) throw new Error("not due")
    expect(d.text).toBe(
      "Gifts for Christmas 2026\n17 days to shop.\nStill needs a gift: Bo.\n1 gift awaiting arrival.",
    )
    expect(d.state.sentOn).toBe("2026-12-01")
  })

  it("sends nothing the second time when nothing changed a day later", async () => {
    const w = await world()
    const first = decideGiftDigest(await w.input(at("2026-12-01"), null))
    if (!first.due) throw new Error("not due")
    const second = decideGiftDigest(await w.input(at("2026-12-02"), first.state))
    expect(second).toEqual({ due: false, reason: "unchanged" })
  })

  it("sends again a day later when something material changed", async () => {
    const w = await world()
    const first = decideGiftDigest(await w.input(at("2026-12-01"), null))
    if (!first.due) throw new Error("not due")
    await w.ledger.update("purchase", w.purchase.id, meta, 1, { received: 1 })
    const second = decideGiftDigest(await w.input(at("2026-12-02"), first.state))
    expect(second).toMatchObject({ due: true })
    if (second.due) expect(second.text).not.toMatch(/awaiting/)
  })

  it("sends one digest a day near the shop-by day, even with no change", async () => {
    const w = await world()
    const first = decideGiftDigest(await w.input(at("2026-12-14"), null))
    if (!first.due) throw new Error("not due")
    const near = decideGiftDigest(await w.input(at("2026-12-15"), first.state))
    expect(near).toMatchObject({ due: true, daysLeft: 3 })
    if (!near.due) throw new Error("not due")
    expect(near.text).toMatch(/^Gifts for Christmas 2026\n3 days to shop\./)
    expect(decideGiftDigest(await w.input(at("2026-12-15", 18), near.state))).toEqual({
      due: false,
      reason: "sent-today",
    })
  })

  it("never puts a price, a note or an item's title in the text", async () => {
    const w = await world()
    const d = decideGiftDigest(await w.input(at("2026-12-01"), null))
    if (!d.due) throw new Error("not due")
    for (const secret of [
      "24.99",
      "2499",
      "$",
      "Lighthouse",
      "puzzle",
      "closet",
      "private",
      "500",
    ]) {
      expect(d.text).not.toContain(secret)
    }
  })

  it("never sends for an occasion without the opt-in", async () => {
    for (const digest of [false, null, undefined]) {
      const w = await world(digest === undefined ? { digest: undefined } : { digest })
      for (const day of ["2026-12-01", "2026-12-17", "2026-12-18"]) {
        expect(decideGiftDigest(await w.input(at(day), null))).toEqual({
          due: false,
          reason: "off",
        })
      }
    }
  })

  it("waits for the owner's hour, stops after the date and when there is nothing to say", async () => {
    const w = await world()
    expect(decideGiftDigest(await w.input(at("2026-12-01", 8), null))).toEqual({
      due: false,
      reason: "not-yet",
    })
    expect(decideGiftDigest(await w.input(at("2026-12-26"), null))).toEqual({
      due: false,
      reason: "past",
    })
    await w.ledger.update("purchase", w.purchase.id, meta, 1, { received: 1 })
    const rows = await w.ledger.list("occasionRecipient", "u1")
    const bo = rows.find((r) => r.recipientId === w.bo.id)
    await w.ledger.update("occasionRecipient", bo?.id ?? "", meta, 1, { decision: "skipped" })
    expect(decideGiftDigest(await w.input(at("2026-12-17"), null))).toEqual({
      due: false,
      reason: "nothing",
    })
  })

  it("counts days to the date when there is no shop-by day, and says when it has passed", async () => {
    const w = await world({ deadline: null })
    const d = decideGiftDigest(await w.input(at("2026-12-23"), null))
    expect(d).toMatchObject({ due: true, daysLeft: 2 })
    if (d.due) expect(d.text).toMatch(/\n2 days to go\./)
    const w2 = await world()
    const late = decideGiftDigest(await w2.input(at("2026-12-20"), null))
    if (late.due) expect(late.text).toMatch(/The shop-by day has passed\./)
    expect(late.due).toBe(true)
  })

  it("names at most ten people and counts the rest", async () => {
    const w = await world()
    for (let i = 0; i < GIFT_DIGEST_NAMES_MAX + 2; i++) {
      const r = await w.ledger.create("recipient", meta, {
        displayName: `P${i}`,
        kind: "person",
        memberIds: [],
        labels: [],
        interests: [],
        avoid: [],
        notes: null,
      })
      await w.ledger.create("occasionRecipient", meta, {
        occasionId: w.xmas.id,
        recipientId: r.id,
        target: null,
        budgetMinor: null,
        decision: "planning",
        skipReason: null,
      })
    }
    const d = decideGiftDigest(await w.input(at("2026-12-01"), null))
    if (!d.due) throw new Error("not due")
    expect(d.text).toMatch(/ and 3 more\.\n/)
  })

  it("keys a day's send per occasion", () => {
    expect(giftDigestKey("go1", "2026-12-01")).toBe("gift-digest:go1:2026-12-01")
  })
})

describe("occasion deadline and digest fields", () => {
  const base = {
    kind: "custom" as const,
    title: "Party",
    date: "2026-06-01",
    timeZone: null,
    year: null,
    currency: "USD",
    budgetMinor: null,
    groupIds: [],
    includeIds: [],
    excludeIds: [],
  }
  it("accepts them left out, null or set, and refuses bad ones", () => {
    expect(giftProblems("occasion", base)).toEqual([])
    expect(giftProblems("occasion", { ...base, deadline: null, digest: null })).toEqual([])
    expect(giftProblems("occasion", { ...base, deadline: "2026-05-20", digest: true })).toEqual([])
    expect(giftProblems("occasion", { ...base, deadline: "2026-06-02" })).toEqual([
      "deadline must be on or before the date",
    ])
    expect(giftProblems("occasion", { ...base, deadline: "soon" })).toEqual([
      "deadline must be a date YYYY-MM-DD",
    ])
    expect(giftProblems("occasion", { ...base, digest: "yes" as unknown as boolean })).toEqual([
      "digest must be true, false or null",
    ])
  })

  it("rolls the shop-by day and the digest choice over with the occasion", async () => {
    const w = await world()
    const p = previewGiftRollover({
      occasion: w.xmas,
      groups: [],
      recipients: await w.ledger.list("recipient", "u1"),
      roster: await w.ledger.list("occasionRecipient", "u1"),
      allocations: [],
    })
    expect(p.occasion).toMatchObject({ date: "2027-12-25", deadline: "2027-12-18", digest: true })
    const moved = previewGiftRollover({
      occasion: w.xmas,
      groups: [],
      recipients: [],
      roster: [],
      allocations: [],
      date: "2027-12-24",
    })
    expect(moved.occasion.deadline).toBe("2027-12-17")
  })
})
