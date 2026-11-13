import { describe, expect, it } from "vitest"

import {
  GIFT_IMPORT_ROWS_MAX,
  GiftLedger,
  type GiftWriteMeta,
  MemoryGiftStore,
  parseGiftImport,
  reviewGiftImport,
} from "../src/index.js"

const T0 = "2026-11-13T12:00:00.000Z"
const meta: GiftWriteMeta = { ownerId: "u1", actor: "u1", source: "import", at: T0 }

function person(ledger: GiftLedger, displayName: string, m: GiftWriteMeta = meta) {
  return ledger.create("recipient", m, {
    displayName,
    kind: "person",
    memberIds: [],
    labels: [],
    interests: [],
    avoid: [],
    notes: null,
  })
}

function christmas(ledger: GiftLedger) {
  return ledger.create("occasion", meta, {
    kind: "christmas",
    title: "Christmas 2026",
    date: "2026-12-25",
    timeZone: null,
    year: 2026,
    currency: "USD",
    budgetMinor: null,
    groupIds: [],
    includeIds: [],
    excludeIds: [],
  })
}

const CSV = [
  "Gift,For,Occasion,Qty,Price,Link,Colour",
  "Puzzle,Ann,Christmas 2026,1,24.99,https://shop.example/puzzle,blue",
  "Socks,Ann;Bo,Christmas 2026,2,$5,,red",
  '"Book, signed",Bo,Christmas 2026,1,12,,',
  '"Mug ""World\'s best""",Ann,,1,,,',
  "Scarf,Bo,Christmas 2026,,,,",
  ",Ann,Christmas 2026,1,3,,",
  "Kite,Ann,Christmas 2026,1,9.5,,",
  '"Notebook\nwith lines",Bo,Christmas 2026,1,,,',
  "Pen,Ann,Christmas 2026,1,2,,",
  "Lamp,Bo,Christmas 2026,1,40,,",
].join("\r\n")

describe("parseGiftImport", () => {
  it("stages a 10-row CSV with one bad row as 9 valid and 1 invalid with its line", () => {
    const staged = parseGiftImport(CSV, { format: "csv", source: "gifts.csv", currency: "USD" })
    expect(staged.problems).toEqual([])
    expect(staged.rows).toHaveLength(10)
    const bad = staged.rows.filter((r) => r.problems.length > 0)
    expect(bad.map((r) => [r.line, r.problems])).toEqual([[7, ["title is missing"]]])
    expect(staged.rows.every((r) => r.source === "gifts.csv")).toBe(true)
    // A quoted field with a newline starts on line 9 and the next row on line 11.
    expect(staged.rows.map((r) => r.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 11, 12])
    expect(staged.rows[7]?.title).toBe("Notebook with lines")
    expect(staged.rows[2]?.title).toBe("Book, signed")
    expect(staged.rows[3]?.title).toBe('Mug "World\'s best"')
    expect(staged.rows[1]).toMatchObject({ recipientNames: ["Ann", "Bo"], quantity: 2 })
    expect(staged.rows[1]?.priceMinor).toBe(500)
    expect(staged.rows[0]).toMatchObject({ priceMinor: 2499, currency: "USD" })
    expect(staged.rows[4]).toMatchObject({ quantity: 1, priceMinor: null, currency: null })
  })

  it("reports an unknown column", () => {
    const staged = parseGiftImport(CSV, { format: "csv", source: "gifts.csv", currency: "USD" })
    expect(staged.unknownColumns).toEqual(["Colour"])
  })

  it("refuses bad quantities, prices, links and currencies on the row", () => {
    const staged = parseGiftImport(
      [
        "title,quantity,price,currency,link",
        "A,0,,,",
        "B,1.5,,,",
        "C,1,abc,USD,",
        "D,1,1.234,USD,",
        "E,1,,,ftp://x.example/",
        "F,1,,,not a link",
        "G,1,3,usdollars,",
        "H,1,3,,",
      ].join("\n"),
      { format: "csv", source: "s" },
    )
    expect(staged.rows.map((r) => r.problems.length > 0)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ])
    expect(staged.rows[7]?.problems).toEqual(["price needs a currency"])
  })

  it("refuses a header with no title column or a column twice, and too many rows", () => {
    expect(parseGiftImport("for,occasion\nAnn,X", { format: "csv", source: "s" }).problems).toEqual(
      ["no title column"],
    )
    expect(parseGiftImport("title,gift\nA,B", { format: "csv", source: "s" }).problems).toEqual([
      "column title appears twice",
    ])
    expect(parseGiftImport("", { format: "csv", source: "s" }).problems).toEqual(["no header row"])
    const many = ["title", ...Array.from({ length: GIFT_IMPORT_ROWS_MAX + 1 }, (_, i) => `g${i}`)]
    expect(parseGiftImport(many.join("\n"), { format: "csv", source: "s" }).rows).toEqual([])
  })

  it("flags a row with more cells than the header", () => {
    const staged = parseGiftImport("title,for\nA,Ann,extra", { format: "csv", source: "s" })
    expect(staged.rows[0]?.problems).toEqual(["has 3 cells, the header 2"])
  })

  it("stages a pasted list, one gift a line, columns by | or tab", () => {
    const staged = parseGiftImport(
      "- Puzzle | Ann, Bo | Christmas 2026 | 2 | 24.99 | https://shop.example/p\n\nSocks\tAnn\n* Kite",
      { format: "list", source: "pasted", currency: "USD" },
    )
    expect(staged.rows.map((r) => [r.line, r.title, r.recipientNames])).toEqual([
      [1, "Puzzle", ["Ann", "Bo"]],
      [3, "Socks", ["Ann"]],
      [4, "Kite", []],
    ])
    expect(staged.rows[0]).toMatchObject({
      occasionName: "Christmas 2026",
      quantity: 2,
      priceMinor: 2499,
      url: "https://shop.example/p",
    })
  })

  it("keys a row by its content, and the same row twice with two keys", () => {
    const a = parseGiftImport("Puzzle | Ann\nSocks\nPuzzle | ann", { format: "list", source: "a" })
    const b = parseGiftImport("Socks\n\n\nPuzzle | Ann", { format: "list", source: "b" })
    expect(a.rows[2]?.key).toBe(`${a.rows[0]?.key}-2`)
    expect(b.rows[1]?.key).toBe(a.rows[0]?.key)
    expect(b.rows[0]?.key).toBe(a.rows[1]?.key)
  })
})

describe("parseGiftImport, awkward input", () => {
  const csv = (text: string, currency = "USD") =>
    parseGiftImport(text, { format: "csv", source: "s", currency })

  it("refuses a quoted field that never closes, naming its line", () => {
    const staged = csv('title,notes\nBook,"open quote\nNext,x\nThird,y')
    expect(staged.problems).toEqual(["a quoted field starting on line 2 never closes"])
    expect(staged.rows).toEqual([])
  })

  it("reads a comma only as a thousands separator", () => {
    const staged = csv('title,price\nA,"1,250.00"\nB,"24,99"\nC,"1,2,3"')
    expect(staged.rows.map((r) => r.priceMinor)).toEqual([125000, null, null])
    expect(staged.rows.map((r) => r.problems.length)).toEqual([0, 1, 1])
  })

  it("takes the currency a symbol names, and refuses a symbol the currency contradicts", () => {
    const staged = csv("title,price,currency\nA,\u00a35,\nB,\u20ac5,USD\nC,$5,")
    expect(staged.rows.map((r) => r.currency)).toEqual(["GBP", "USD", "USD"])
    expect(staged.rows[1]?.problems).toEqual(["the price is in EUR but the currency is USD"])
  })

  it("reads a quoted header after a byte order mark, and skips rows of empty cells", () => {
    const staged = csv('\uFEFF"title","notes",\nBook,x,\n,,\n,\nPen,y,')
    expect(staged.problems).toEqual([])
    expect(staged.unknownColumns).toEqual([])
    expect(staged.rows.map((r) => [r.line, r.title])).toEqual([
      [2, "Book"],
      [5, "Pen"],
    ])
  })

  it("counts a CR line break inside quotes", () => {
    const staged = csv('title,notes\r"a\rb",x\rNext,y')
    expect(staged.rows.map((r) => r.line)).toEqual([2, 4])
  })

  it("names a link that is too long", () => {
    const staged = csv(`title,link\nA,https://x.example/${"a".repeat(2000)}`)
    expect(staged.rows[0]?.problems).toEqual(["link is longer than 2000"])
  })

  it("refuses a default currency that is not a code", () => {
    expect(csv("title\nA", "usd").problems).toEqual([
      "the default currency must be an ISO 4217 code, such as USD",
    ])
  })

  it("keys recipients in any order alike, and refuses a pasted list over the limit", () => {
    const a = parseGiftImport("Book | Ann; Bo", { format: "list", source: "s" })
    const b = parseGiftImport("Book | bo; Ann", { format: "list", source: "s" })
    expect(b.rows[0]?.key).toBe(a.rows[0]?.key)
    const many = Array.from({ length: GIFT_IMPORT_ROWS_MAX + 1 }, (_, i) => `g${i}`).join("\n")
    expect(parseGiftImport(many, { format: "list", source: "s" }).problems).toEqual([
      `more than ${GIFT_IMPORT_ROWS_MAX} rows`,
    ])
  })
})

describe("reviewGiftImport", () => {
  it("matches names, flags a new one and an ambiguous one", async () => {
    const ledger = new GiftLedger(new MemoryGiftStore())
    const ann = await person(ledger, "Ann")
    await person(ledger, "Bo")
    await person(ledger, "bo ")
    const xmas = await christmas(ledger)
    const staged = parseGiftImport(
      "Puzzle | ann | christmas 2026\nSocks | Bo | Christmas 2026\nKite | Cy\nBad | Ann | | 0",
      { format: "list", source: "s" },
    )
    const reviewed = reviewGiftImport(staged.rows, {
      recipients: await ledger.list("recipient", "u1"),
      occasions: await ledger.list("occasion", "u1"),
    })
    expect(reviewed.map((r) => r.status)).toEqual(["ready", "ambiguous", "new", "invalid"])
    expect(reviewed[0]?.recipients).toEqual([{ name: "ann", status: "matched", ids: [ann.id] }])
    expect(reviewed[0]?.occasion).toEqual({
      name: "christmas 2026",
      status: "matched",
      ids: [xmas.id],
    })
    expect(reviewed[1]?.recipients[0]?.ids).toHaveLength(2)
  })
})

describe("GiftLedger.applyGiftImport", () => {
  async function setup() {
    const ledger = new GiftLedger(new MemoryGiftStore())
    const ann = await person(ledger, "Ann")
    const bo = await person(ledger, "Bo")
    const xmas = await christmas(ledger)
    const review = async (text: string) =>
      reviewGiftImport(
        parseGiftImport(text, { format: "list", source: "s", currency: "USD" }).rows,
        {
          recipients: await ledger.list("recipient", "u1"),
          occasions: await ledger.list("occasion", "u1"),
        },
      )
    return { ledger, ann, bo, xmas, review }
  }

  it("allocates a row for two matched people as one gift each, and adds them to the roster", async () => {
    const w = await setup()
    const [out] = await w.ledger.applyGiftImport(
      meta,
      await w.review("Socks | Ann; Bo | Christmas 2026 | 2 | 5"),
      { currency: "USD" },
    )
    expect(out).toMatchObject({ status: "applied", problems: [] })
    const [a] = await w.ledger.list("allocation", "u1")
    expect(a).toMatchObject({
      id: out?.allocationId,
      itemId: out?.itemId,
      occasionId: w.xmas.id,
      recipientIds: [w.ann.id, w.bo.id],
      quantity: 2,
      shared: false,
      purchaseId: null,
    })
    const item = await w.ledger.get("item", "u1", out?.itemId ?? "")
    expect(item).toMatchObject({
      planning: "selected",
      estimateMinor: 500,
      currency: "USD",
      source: { kind: "import", ref: out?.key },
    })
    const roster = await w.ledger.list("occasionRecipient", "u1", { occasionId: w.xmas.id })
    expect(roster.map((r) => r.recipientId).sort()).toEqual([w.ann.id, w.bo.id].sort())
  })

  it("importing twice gives one set of gifts", async () => {
    const w = await setup()
    const text = "Puzzle | Ann | Christmas 2026\nKite | Cy | Birthday\nSocks\nSocks"
    const reviewed = await w.review(text)
    const first = await w.ledger.applyGiftImport(meta, reviewed, { currency: "USD" })
    const second = await w.ledger.applyGiftImport(meta, await w.review(text), { currency: "USD" })
    expect(first.map((o) => o.status)).toEqual(["applied", "applied", "applied", "applied"])
    expect(second.map((o) => [o.status, o.itemId, o.allocationId])).toEqual(
      first.map((o) => [o.status, o.itemId, o.allocationId]),
    )
    expect(await w.ledger.list("item", "u1")).toHaveLength(4)
    expect(await w.ledger.list("allocation", "u1")).toHaveLength(2)
    expect((await w.ledger.list("recipient", "u1")).map((r) => r.displayName)).toEqual([
      "Ann",
      "Bo",
      "Cy",
    ])
    expect((await w.ledger.list("occasion", "u1")).map((o) => o.title)).toEqual([
      "Christmas 2026",
      "Birthday",
    ])
    // Retrying the first review, made before Cy and Birthday existed, replays too.
    const retry = await w.ledger.applyGiftImport(meta, reviewed, { currency: "USD" })
    expect(retry).toEqual(first)
    expect(await w.ledger.list("item", "u1")).toHaveLength(4)
  })

  it("never applies an ambiguous or invalid row", async () => {
    const w = await setup()
    await person(w.ledger, "ann")
    const out = await w.ledger.applyGiftImport(
      meta,
      await w.review("Puzzle | Ann | Christmas 2026\nKite | | | 0"),
      { currency: "USD" },
    )
    expect(out.map((o) => o.status)).toEqual(["skipped", "skipped"])
    expect(out[0]?.problems[0]).toMatch(/more than one/)
    expect(out[1]?.problems).toEqual(["quantity must be a whole number of at least 1"])
    expect(await w.ledger.list("item", "u1")).toEqual([])
  })

  it("skips a row whose match moved since the review", async () => {
    const w = await setup()
    const reviewed = await w.review("Puzzle | Ann | Christmas 2026")
    await w.ledger.update("recipient", w.ann.id, meta, 1, { displayName: "Annie" })
    const [out] = await w.ledger.applyGiftImport(meta, reviewed, { currency: "USD" })
    expect(out).toMatchObject({ status: "skipped" })
    expect(out?.problems[0]).toMatch(/changed since the review/)
  })

  it("leaves someone taken off the occasion off its roster, with a note", async () => {
    const w = await setup()
    const row = await w.ledger.create("occasionRecipient", meta, {
      occasionId: w.xmas.id,
      recipientId: w.ann.id,
      target: null,
      budgetMinor: null,
      decision: "planning",
      skipReason: null,
    })
    await w.ledger.update("occasionRecipient", row.id, meta, 1, { archived: true })
    const [out] = await w.ledger.applyGiftImport(
      meta,
      await w.review("Puzzle | Ann | Christmas 2026"),
      { currency: "USD" },
    )
    expect(out?.status).toBe("applied")
    expect(out?.problems).toEqual([`${w.ann.id} was taken off this occasion; left off its roster`])
    expect(await w.ledger.list("occasionRecipient", "u1", { occasionId: w.xmas.id })).toEqual([])
  })

  it("stops a row whose key was used before for other records, and carries on", async () => {
    const w = await setup()
    const reviewed = await w.review("Puzzle\nKite")
    const key = reviewed[0]?.key ?? ""
    // That row's key already used for another request: the write is refused.
    await w.ledger.create(
      "item",
      { ...meta, idempotencyKey: `import:${key}/item` },
      {
        title: "Something else",
        url: null,
        productKey: null,
        variant: null,
        notes: null,
        source: { kind: "manual", ref: null },
        planning: "idea",
        estimateMinor: null,
        currency: null,
      },
    )
    const out = await w.ledger.applyGiftImport(meta, reviewed, { currency: "USD" })
    expect(out.map((o) => o.status)).toEqual(["skipped", "applied"])
    expect(out[0]?.problems[0]).toMatch(/imported before/)
  })

  it("never gives a row reviewed as new to a record it made before that has since changed", async () => {
    const w = await setup()
    const text = "Kite | Cy | Birthday"
    const [first] = await w.ledger.applyGiftImport(meta, await w.review(text), { currency: "USD" })
    const [occasion] = (await w.ledger.list("occasion", "u1")).filter((o) => o.title === "Birthday")
    await w.ledger.update("occasion", occasion?.id ?? "", meta, 1, { archived: true })
    const cy = (await w.ledger.list("recipient", "u1")).find((r) => r.displayName === "Cy")
    await w.ledger.update("recipient", cy?.id ?? "", meta, 1, { displayName: "Cyril" })
    const reviewed = await w.review(text)
    expect(reviewed[0]?.status).toBe("new")
    const [again] = await w.ledger.applyGiftImport(meta, reviewed, { currency: "USD" })
    expect(again).toMatchObject({ status: "skipped", allocationId: null })
    expect(again?.problems[0]).toMatch(/earlier import and has changed/)
    expect(first?.status).toBe("applied")
    // Another row naming them is new content: it makes a new Cy and a new Birthday.
    const [other] = await w.ledger.applyGiftImport(meta, await w.review("Yoyo | cy | birthday"), {
      currency: "USD",
    })
    expect(other?.status).toBe("applied")
    const live = await w.ledger.list("occasion", "u1")
    expect(live.map((o) => o.title)).toEqual(["Christmas 2026", "birthday"])
  })

  it("matches only live records, and makes one person for a name written twice", async () => {
    const w = await setup()
    await w.ledger.update("recipient", w.bo.id, meta, 1, { archived: true })
    const out = await w.ledger.applyGiftImport(
      meta,
      await w.review("Socks | Bo | Christmas 2026\nKite | bo | Christmas 2026"),
      { currency: "USD" },
    )
    expect(out.map((o) => o.status)).toEqual(["applied", "applied"])
    const bos = (await w.ledger.list("recipient", "u1")).filter((r) => r.displayName === "Bo")
    expect(bos).toHaveLength(1)
    expect(bos[0]?.id).not.toBe(w.bo.id)
  })

  it("ignores the caller's idempotency key: a new key still replays the rows", async () => {
    const w = await setup()
    const text = "Puzzle | Ann | Christmas 2026"
    await w.ledger.applyGiftImport({ ...meta, idempotencyKey: "a" }, await w.review(text), {
      currency: "USD",
    })
    await w.ledger.applyGiftImport({ ...meta, idempotencyKey: "b" }, await w.review(text), {
      currency: "USD",
    })
    expect(await w.ledger.list("item", "u1")).toHaveLength(1)
  })

  it("refuses a default currency that is not a code before writing anything", async () => {
    const w = await setup()
    await expect(
      w.ledger.applyGiftImport(meta, await w.review("Kite | Cy | Birthday"), { currency: "usd" }),
    ).rejects.toThrow(/ISO 4217/)
    expect(await w.ledger.list("recipient", "u1")).toHaveLength(2)
  })
})
