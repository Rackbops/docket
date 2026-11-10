import type { GiftFieldsByKind, GiftKind } from "./gift-model.js"

/**
 * What `GiftLedger` refuses before a write (plan item 158): pure checks on one record's fields,
 * every problem listed. References to other records are checked by the ledger against the store.
 */

export const GIFT_TEXT_MAX = 200
export const GIFT_NOTES_MAX = 2000
export const GIFT_LABEL_MAX = 40
export const GIFT_LABELS_MAX = 20
export const GIFT_IDS_MAX = 500

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/** A calendar date that exists: 2026-02-31 does not. */
function realDate(v: string): boolean {
  const [y, m, d] = v.split("-").map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}
const CURRENCY = /^[A-Z]{3}$/

type Fields = Record<string, unknown>

class Checker {
  readonly problems: string[] = []
  constructor(private readonly f: Fields) {}

  private bad(name: string, why: string): void {
    this.problems.push(`${name} ${why}`)
  }

  text(name: string, max = GIFT_TEXT_MAX, nullable = false): void {
    const v = this.f[name]
    if (v === null && nullable) return
    if (typeof v !== "string" || v.trim() === "") {
      this.bad(name, "must be text")
      return
    }
    if (v.length > max) this.bad(name, `is longer than ${max} characters`)
  }

  oneOf(name: string, allowed: readonly string[]): void {
    if (!allowed.includes(this.f[name] as string)) {
      this.bad(name, `must be one of ${allowed.join(", ")}`)
    }
  }

  count(name: string, min: number, nullable = false): void {
    const v = this.f[name]
    if (v === null && nullable) return
    if (!Number.isSafeInteger(v) || (v as number) < min) {
      this.bad(name, `must be a whole number of at least ${min}`)
    }
  }

  money(name: string, nullable = true): void {
    this.count(name, 0, nullable)
  }

  currency(name: string, nullable = false): void {
    const v = this.f[name]
    if (v === null && nullable) return
    if (typeof v !== "string" || !CURRENCY.test(v)) this.bad(name, "must be an ISO 4217 code")
  }

  date(name: string): void {
    const v = this.f[name]
    if (v === null) return
    if (typeof v !== "string" || !DATE.test(v) || !realDate(v)) {
      this.bad(name, "must be a date YYYY-MM-DD")
    }
  }

  flag(name: string): void {
    if (typeof this.f[name] !== "boolean") this.bad(name, "must be true or false")
  }

  labels(name: string): void {
    const v = this.f[name]
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      this.bad(name, "must be a list of text")
      return
    }
    if (v.length > GIFT_LABELS_MAX) this.bad(name, `holds more than ${GIFT_LABELS_MAX} entries`)
    if (v.some((x: string) => x.trim() === "" || x.length > GIFT_LABEL_MAX)) {
      this.bad(name, `entries must be 1 to ${GIFT_LABEL_MAX} characters`)
    }
  }

  ids(name: string, min: number): void {
    const v = this.f[name]
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "")) {
      this.bad(name, "must be a list of ids")
      return
    }
    if (v.length < min) this.bad(name, `needs at least ${min}`)
    if (v.length > GIFT_IDS_MAX) this.bad(name, `holds more than ${GIFT_IDS_MAX} ids`)
    if (new Set(v).size !== v.length) this.bad(name, "repeats an id")
  }

  id(name: string, nullable = false): void {
    const v = this.f[name]
    if (v === null && nullable) return
    if (typeof v !== "string" || v === "") this.bad(name, "must be an id")
  }
}

const CHECKS: { [K in GiftKind]: (c: Checker, f: GiftFieldsByKind[K]) => void } = {
  recipient(c, f) {
    c.text("displayName")
    c.oneOf("kind", ["person", "household"])
    c.ids("memberIds", f.kind === "household" ? 1 : 0)
    if (f.kind === "person" && Array.isArray(f.memberIds) && f.memberIds.length > 0) {
      c.problems.push("memberIds is only for a household")
    }
    c.labels("labels")
    c.labels("interests")
    c.labels("avoid")
    c.text("notes", GIFT_NOTES_MAX, true)
  },
  group(c) {
    c.text("name")
    c.ids("memberIds", 0)
  },
  occasion(c, f) {
    c.oneOf("kind", ["christmas", "birthday", "anniversary", "custom"])
    c.text("title")
    c.date("date")
    c.text("timeZone", 64, true)
    if (f.year !== null && (!Number.isSafeInteger(f.year) || f.year < 1900 || f.year > 9999)) {
      c.problems.push("year must be a year between 1900 and 9999")
    }
    if (
      typeof f.year === "number" &&
      typeof f.date === "string" &&
      !f.date.startsWith(`${f.year}-`)
    ) {
      c.problems.push("year must be the date's year")
    }
    c.currency("currency")
    c.money("budgetMinor")
  },
  occasionRecipient(c, f) {
    c.id("occasionId")
    c.id("recipientId")
    c.count("target", 0, true)
    c.money("budgetMinor")
    c.oneOf("decision", ["planning", "complete", "skipped"])
    c.text("skipReason", GIFT_TEXT_MAX, true)
    if (f.decision !== "skipped" && f.skipReason !== null) {
      c.problems.push("skipReason is only for a skipped recipient")
    }
  },
  item(c, f) {
    c.text("title")
    c.text("url", 2000, true)
    c.text("productKey", GIFT_TEXT_MAX, true)
    c.text("variant", GIFT_TEXT_MAX, true)
    c.text("notes", GIFT_NOTES_MAX, true)
    const source = f.source as unknown
    if (
      typeof source !== "object" ||
      source === null ||
      !["manual", "scout", "import"].includes((source as { kind?: string }).kind ?? "") ||
      !(
        (source as { ref?: unknown }).ref === null ||
        typeof (source as { ref?: unknown }).ref === "string"
      )
    ) {
      c.problems.push("source must be { kind: manual|scout|import, ref }")
    }
    c.oneOf("planning", ["idea", "shortlisted", "selected", "rejected"])
    c.money("estimateMinor")
    c.currency("currency", true)
    if (f.estimateMinor !== null && f.currency === null) {
      c.problems.push("estimateMinor needs a currency")
    }
  },
  purchase(c, f) {
    c.id("itemId")
    c.text("merchant", GIFT_TEXT_MAX, true)
    c.currency("currency")
    c.money("unitPriceMinor", false)
    for (const q of ["ordered", "received", "cancelled", "returned"] as const) c.count(q, 0)
    for (const m of ["taxMinor", "shippingMinor", "discountMinor"] as const) c.money(m)
    c.flag("totalComplete")
    c.money("refundedMinor", false)
    c.date("purchasedOn")
    c.text("reference", GIFT_TEXT_MAX, true)
    const n = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : 0)
    if (n(f.received) + n(f.cancelled) > n(f.ordered)) {
      c.problems.push("received and cancelled together cannot exceed ordered")
    }
    if (n(f.returned) > n(f.received)) c.problems.push("returned cannot exceed received")
    if (f.totalComplete === true && [f.taxMinor, f.shippingMinor, f.discountMinor].includes(null)) {
      c.problems.push("totalComplete needs tax, shipping and discount, each 0 when there is none")
    }
    // Cancelled units were never charged, so money back is for returned units and their tax and
    // shipping only; a refund for a cancelled unit would lower net spend twice.
    const price = n(f.unitPriceMinor)
    const extras = n(f.taxMinor) + n(f.shippingMinor)
    if (n(f.refundedMinor) > price * n(f.returned) + extras) {
      c.problems.push("refundedMinor cannot exceed the returned units' price plus tax and shipping")
    }
    const bought = Math.max(0, n(f.ordered) - n(f.cancelled))
    if (n(f.discountMinor) > price * bought + extras) {
      c.problems.push("discountMinor cannot exceed the line's price plus tax and shipping")
    }
  },
  allocation(c, f) {
    c.id("itemId")
    c.id("occasionId")
    c.ids("recipientIds", 1)
    c.count("quantity", 1)
    c.flag("shared")
    c.id("purchaseId", true)
    c.oneOf("handoff", ["none", "wrapped", "ready", "given"])
    c.date("givenOn")
    if (f.givenOn !== null && f.handoff !== "given") {
      c.problems.push("givenOn is only for a given gift")
    }
  },
}

/** The field names of each kind, exactly: a record with any other key is refused, not trimmed. */
export const GIFT_FIELD_NAMES: { [K in GiftKind]: readonly (keyof GiftFieldsByKind[K])[] } = {
  recipient: ["displayName", "kind", "memberIds", "labels", "interests", "avoid", "notes"],
  group: ["name", "memberIds"],
  occasion: ["kind", "title", "date", "timeZone", "year", "currency", "budgetMinor"],
  occasionRecipient: [
    "occasionId",
    "recipientId",
    "target",
    "budgetMinor",
    "decision",
    "skipReason",
  ],
  item: [
    "title",
    "url",
    "productKey",
    "variant",
    "notes",
    "source",
    "planning",
    "estimateMinor",
    "currency",
  ],
  purchase: [
    "itemId",
    "merchant",
    "currency",
    "unitPriceMinor",
    "ordered",
    "received",
    "cancelled",
    "returned",
    "taxMinor",
    "shippingMinor",
    "discountMinor",
    "totalComplete",
    "refundedMinor",
    "purchasedOn",
    "reference",
  ],
  allocation: [
    "itemId",
    "occasionId",
    "recipientIds",
    "quantity",
    "shared",
    "purchaseId",
    "handoff",
    "givenOn",
  ],
}

/** Every problem with one record's complete fields; empty when it may be written. */
export function giftProblems<K extends GiftKind>(kind: K, fields: GiftFieldsByKind[K]): string[] {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return ["fields must be an object"]
  }
  const names = GIFT_FIELD_NAMES[kind] as readonly string[]
  const problems: string[] = []
  for (const key of Object.keys(fields)) {
    if (!names.includes(key)) problems.push(`${key} is not a ${kind} field`)
  }
  for (const name of names) {
    if (!(name in fields)) problems.push(`${name} is missing`)
  }
  if (problems.length > 0) return problems
  const c = new Checker(fields as unknown as Fields)
  CHECKS[kind](c, fields)
  return c.problems
}
