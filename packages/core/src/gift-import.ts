import type { GiftLedger } from "./gift-ledger.js"
import type { GiftOccasion, GiftRecipient } from "./gift-model.js"
import type { GiftWriteMeta } from "./gift-ports.js"
import { GIFT_NOTES_MAX, GIFT_TEXT_MAX } from "./gift-validate.js"

/**
 * Reviewed gift import (docket#102, design docket#92 "Capture, discovery, and notifications").
 * Three steps, the first two pure:
 *
 * 1. `parseGiftImport` turns CSV, or a pasted list, into staged rows: one gift a row, each with
 *    its provenance (source and line) and an idempotency key made from its content.
 * 2. `reviewGiftImport` matches each row's people and occasion to the owner's records by name,
 *    and marks the row `ready`, `new` (it names someone or something not there yet, which applying
 *    creates), `ambiguous` (a name matches more than one) or `invalid`. The owner looks at this
 *    before anything is written.
 * 3. `GiftLedger.applyGiftImport` writes the rows the owner approved and answers each with its
 *    own outcome; it is not atomic. Every write is keyed by the row's content, so importing the
 *    same rows again -- a retry, or the same file next week -- creates nothing twice.
 *
 * CSV has a header row; a column it does not know is reported (`unknownColumns`), never silently
 * dropped. A pasted list is one gift a line, its columns split by `|` or a tab, in the order
 * title, recipients, occasion, quantity, price, link. Recipients are split by `;` (and `,` in a
 * pasted list). Everything read is text: nothing in a row is ever followed as an instruction.
 */

/** The most rows one import stages; a longer one is refused whole. */
export const GIFT_IMPORT_ROWS_MAX = 500

export type GiftImportColumn =
  | "title"
  | "recipients"
  | "occasion"
  | "quantity"
  | "price"
  | "currency"
  | "link"
  | "notes"

/** Header names each column answers to, folded. */
const ALIASES: Record<GiftImportColumn, readonly string[]> = {
  title: ["title", "gift", "item", "name"],
  recipients: ["recipients", "recipient", "for", "people", "person"],
  occasion: ["occasion", "event"],
  quantity: ["quantity", "qty", "count"],
  price: ["price", "estimate", "cost"],
  currency: ["currency"],
  link: ["link", "url"],
  notes: ["notes", "note", "comment", "comments"],
}

const LIST_ORDER: readonly GiftImportColumn[] = [
  "title",
  "recipients",
  "occasion",
  "quantity",
  "price",
  "link",
]

const fold = (v: string): string => v.trim().replace(/\s+/g, " ").toLowerCase()

/** One staged gift, before review. */
export interface GiftImportRow {
  /** Where it came from: the source the host named, and its 1-based line (a CSV row's first). */
  source: string
  line: number
  /** Made from the row's content, so the same row imported again has the same key. */
  key: string
  title: string
  recipientNames: string[]
  occasionName: string | null
  quantity: number
  priceMinor: number | null
  currency: string | null
  url: string | null
  notes: string | null
  /** Why the row cannot be imported; empty when it can. */
  problems: string[]
}

export interface GiftImportStaged {
  rows: GiftImportRow[]
  /** Header columns the parser does not know, as written. */
  unknownColumns: string[]
  /** Problems with the whole input (no header, a repeated column, too many rows). */
  problems: string[]
}

export interface GiftImportOptions {
  format: "csv" | "list"
  /** A name for the input, kept on every row (a file name, "pasted"). */
  source: string
  /** The currency a price is in when its row names none. */
  currency?: string
}

/** CSV records with the line each starts on: quotes, doubled quotes and newlines inside quotes. */
function csvRecords(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let cell = ""
  let quoted = false
  let line = 1
  let start = 1
  let any = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ""
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else {
        if (ch === "\n") line++
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell === "") {
      quoted = true
      any = true
    } else if (ch === ",") {
      cells.push(cell)
      cell = ""
      any = true
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      cells.push(cell)
      if (any || cells.some((c) => c.trim() !== "")) out.push({ line: start, cells })
      cells = []
      cell = ""
      any = false
      line++
      start = line
    } else {
      cell += ch
      if (ch.trim() !== "") any = true
    }
  }
  cells.push(cell)
  if (any || cells.some((c) => c.trim() !== "")) out.push({ line: start, cells })
  return out
}

/** A price as minor units: `24.99`, `$24.99`, `24` -- at most two decimals, never negative. */
function priceMinor(raw: string): number | null | "bad" {
  const t = raw
    .trim()
    .replace(/^[$£€]/, "")
    .replace(/,/g, "")
  if (t === "") return null
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return "bad"
  const [whole, frac = ""] = t.split(".")
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"))
}

/** FNV-1a over the text, as 13 base-36 digits: a stable key, not a secret. */
function hash(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const ch of text) {
    h ^= BigInt(ch.codePointAt(0) ?? 0)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(36).padStart(13, "0")
}

function stage(
  source: string,
  line: number,
  get: (c: GiftImportColumn) => string,
  options: GiftImportOptions,
): Omit<GiftImportRow, "key"> {
  const problems: string[] = []
  const title = get("title").trim().replace(/\s+/g, " ")
  if (title === "") problems.push("title is missing")
  else if (title.length > GIFT_TEXT_MAX) problems.push(`title is longer than ${GIFT_TEXT_MAX}`)
  const names = get("recipients")
    .split(options.format === "list" ? /[;,]/ : /;/)
    .map((n) => n.trim().replace(/\s+/g, " "))
    .filter((n) => n !== "")
  const unique = [...new Map(names.map((n) => [fold(n), n])).values()]
  const occasion = get("occasion").trim().replace(/\s+/g, " ")
  const qRaw = get("quantity").trim()
  const quantity = qRaw === "" ? 1 : /^\d{1,4}$/.test(qRaw) ? Number(qRaw) : Number.NaN
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    problems.push("quantity must be a whole number of at least 1")
  }
  const price = priceMinor(get("price"))
  if (price === "bad") problems.push("price must be an amount such as 24.99")
  const cRaw = get("currency").trim().toUpperCase()
  const currency = cRaw !== "" ? cRaw : price !== null ? (options.currency ?? null) : null
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    problems.push("currency must be an ISO 4217 code")
  }
  if (typeof price === "number" && currency === null) problems.push("price needs a currency")
  const link = get("link").trim()
  let url: string | null = null
  if (link !== "") {
    try {
      const u = new URL(link)
      if ((u.protocol === "http:" || u.protocol === "https:") && link.length <= 2000) url = link
    } catch {
      // Not an address; refused below.
    }
    if (url === null) problems.push("link must be an http or https address")
  }
  const notes = get("notes").trim()
  if (notes.length > GIFT_NOTES_MAX) problems.push(`notes is longer than ${GIFT_NOTES_MAX}`)
  for (const n of [...unique, occasion]) {
    if (n.length > GIFT_TEXT_MAX) problems.push(`a name is longer than ${GIFT_TEXT_MAX}`)
  }
  return {
    source,
    line,
    title,
    recipientNames: unique,
    occasionName: occasion === "" ? null : occasion,
    quantity: Number.isSafeInteger(quantity) ? quantity : 1,
    priceMinor: typeof price === "number" ? price : null,
    currency,
    url,
    notes: notes === "" ? null : notes,
    problems,
  }
}

/**
 * Stages CSV or a pasted list (see the module comment). Pure: nothing is matched or written. Two
 * rows with the same content get keys `<hash>` and `<hash>-2`, so a file listing one gift twice
 * imports it twice, and importing the file again imports neither again.
 */
export function parseGiftImport(text: string, options: GiftImportOptions): GiftImportStaged {
  const staged: GiftImportStaged = { rows: [], unknownColumns: [], problems: [] }
  const raw: Omit<GiftImportRow, "key">[] = []
  if (options.format === "csv") {
    const [header, ...records] = csvRecords(text)
    if (header === undefined) {
      staged.problems.push("no header row")
      return staged
    }
    const at = new Map<GiftImportColumn, number>()
    header.cells.forEach((name, i) => {
      const col = (Object.keys(ALIASES) as GiftImportColumn[]).find((c) =>
        ALIASES[c].includes(fold(name)),
      )
      if (col === undefined) staged.unknownColumns.push(name.trim())
      else if (at.has(col)) staged.problems.push(`column ${col} appears twice`)
      else at.set(col, i)
    })
    if (!at.has("title")) staged.problems.push("no title column")
    if (records.length > GIFT_IMPORT_ROWS_MAX) {
      staged.problems.push(`more than ${GIFT_IMPORT_ROWS_MAX} rows`)
    }
    if (staged.problems.length > 0) return staged
    for (const r of records) {
      const row = stage(options.source, r.line, (c) => r.cells[at.get(c) ?? -1] ?? "", options)
      if (r.cells.length > header.cells.length) {
        row.problems.push(`has ${r.cells.length} cells, the header ${header.cells.length}`)
      }
      raw.push(row)
    }
  } else {
    const lines = text.split(/\r\n|\r|\n/)
    const used = lines.filter((l) => l.trim() !== "")
    if (used.length > GIFT_IMPORT_ROWS_MAX) {
      staged.problems.push(`more than ${GIFT_IMPORT_ROWS_MAX} rows`)
      return staged
    }
    lines.forEach((l, i) => {
      if (l.trim() === "") return
      const cells = l.replace(/^\s*[-*]\s+/, "").split(/\t|\|/)
      const row = stage(options.source, i + 1, (c) => cells[LIST_ORDER.indexOf(c)] ?? "", options)
      if (cells.length > LIST_ORDER.length) {
        row.problems.push(`has ${cells.length} columns, at most ${LIST_ORDER.length}`)
      }
      raw.push(row)
    })
  }
  const seen = new Map<string, number>()
  for (const r of raw) {
    const content = JSON.stringify([
      r.title,
      r.recipientNames.map(fold),
      r.occasionName === null ? null : fold(r.occasionName),
      r.quantity,
      r.priceMinor,
      r.currency,
      r.url,
      r.notes,
    ])
    const base = hash(content)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    staged.rows.push({ ...r, key: n === 1 ? base : `${base}-${n}` })
  }
  return staged
}

/** How one name matched: one record, none (new), or several (ambiguous). */
export interface GiftImportMatch {
  name: string
  status: "matched" | "new" | "ambiguous"
  ids: string[]
}

export type GiftImportStatus = "ready" | "new" | "ambiguous" | "invalid"

export interface GiftImportReviewed extends GiftImportRow {
  status: GiftImportStatus
  recipients: GiftImportMatch[]
  occasion: GiftImportMatch | null
}

/**
 * Matches each staged row to the owner's live recipients and occasions by name (trimmed, spaced
 * once, case-folded: a recipient's `displayName`, an occasion's `title`). A row is `invalid` when
 * it has problems, `ambiguous` when any name matches more than one record, `new` when any names
 * nothing yet, and `ready` otherwise. Pure.
 */
export function reviewGiftImport(
  rows: readonly GiftImportRow[],
  owner: { recipients: readonly GiftRecipient[]; occasions: readonly GiftOccasion[] },
): GiftImportReviewed[] {
  const match = (name: string, records: readonly { id: string; label: string }[]) => {
    const ids = records.filter((r) => fold(r.label) === fold(name)).map((r) => r.id)
    const status: GiftImportMatch["status"] =
      ids.length === 0 ? "new" : ids.length === 1 ? "matched" : "ambiguous"
    return { name, status, ids }
  }
  const people = owner.recipients
    .filter((r) => !r.archived)
    .map((r) => ({ id: r.id, label: r.displayName }))
  const occasions = owner.occasions
    .filter((o) => !o.archived)
    .map((o) => ({ id: o.id, label: o.title }))
  return rows.map((row) => {
    const recipients = row.recipientNames.map((n) => match(n, people))
    const occasion = row.occasionName === null ? null : match(row.occasionName, occasions)
    const all = occasion === null ? recipients : [...recipients, occasion]
    const status: GiftImportStatus =
      row.problems.length > 0
        ? "invalid"
        : all.some((m) => m.status === "ambiguous")
          ? "ambiguous"
          : all.some((m) => m.status === "new")
            ? "new"
            : "ready"
    return { ...row, status, recipients, occasion }
  })
}

export interface GiftImportApplyOptions {
  /** The currency of an occasion the import creates when its first row names none. */
  currency: string
}

/** What applying one row did. */
export interface GiftImportOutcome {
  key: string
  source: string
  line: number
  /** `applied`: its item (and gift, when it names people and an occasion) is written. */
  status: "applied" | "skipped" | "failed"
  itemId: string | null
  allocationId: string | null
  /** Why it was skipped or failed, or notes on an applied row. */
  problems: string[]
}

/**
 * The writes behind `GiftLedger.applyGiftImport`, through the ledger's own checked `create`. The
 * rows are reviewed again against the store first: a row that is `invalid` or `ambiguous` now, or
 * a name the owner saw matched to one record that now matches another, is skipped; a name seen as
 * `new` that matches one record now uses it (an earlier run of this import made it).
 *
 * Every write carries an idempotency key made from content, never from the caller's key:
 * `import:recipient:<name>` and `import:occasion:<name>` (folded) for a record the import
 * creates, and `import:<row key>/item`, `/allocation` and `/roster/<recipient>` for a row's own,
 * so a second import of the same content replays instead of writing. A new recipient is a person
 * with nothing but its name; a new occasion is `custom`, with no date. The item is an idea (or
 * `selected` when the row allocates it), its price a planning estimate (never spend), its source
 * `import` with the row key as ref. A row naming people and an occasion becomes one unbought gift,
 * one unit each (`shared` false), and each of its people not on that occasion's roster gets a
 * planning row; a person with an archived row there is left off it, with a note.
 */
export async function applyGiftImportRows(
  ledger: GiftLedger,
  meta: GiftWriteMeta,
  rows: readonly GiftImportReviewed[],
  options: GiftImportApplyOptions,
): Promise<GiftImportOutcome[]> {
  const { idempotencyKey: _ignored, ...base } = meta
  const keyed = (key: string): GiftWriteMeta => ({ ...base, idempotencyKey: key })
  const all = { includeArchived: true }
  const fresh = reviewGiftImport(rows, {
    recipients: await ledger.list("recipient", meta.ownerId, all),
    occasions: await ledger.list("occasion", meta.ownerId, all),
  })
  const made = new Map<string, string>()
  const outcomes: GiftImportOutcome[] = []
  for (const [i, seen] of rows.entries()) {
    const now = fresh[i] as GiftImportReviewed
    const out: GiftImportOutcome = {
      key: seen.key,
      source: seen.source,
      line: seen.line,
      status: "skipped",
      itemId: null,
      allocationId: null,
      problems: [],
    }
    outcomes.push(out)
    if (seen.status === "invalid" || now.status === "invalid") {
      out.problems.push(...now.problems)
      continue
    }
    const pairs: [GiftImportMatch, GiftImportMatch | undefined][] = [
      ...seen.recipients.map((m, j): [GiftImportMatch, GiftImportMatch | undefined] => [
        m,
        now.recipients[j],
      ]),
      ...(seen.occasion === null
        ? []
        : [[seen.occasion, now.occasion ?? undefined] as [GiftImportMatch, GiftImportMatch]]),
    ]
    for (const [was, is] of pairs) {
      if (is === undefined || is.status === "ambiguous" || was.status === "ambiguous") {
        out.problems.push(`"${was.name}" matches more than one; choose one and import again`)
      } else if (was.status === "matched" && (is.ids[0] !== was.ids[0] || is.ids.length !== 1)) {
        out.problems.push(`"${was.name}" changed since the review; review again`)
      }
    }
    if (out.problems.length > 0) continue
    try {
      const recipientIds: string[] = []
      for (const m of now.recipients) {
        const k = `recipient:${fold(m.name)}`
        let id = m.ids[0] ?? made.get(k)
        if (id === undefined) {
          id = (
            await ledger.create("recipient", keyed(`import:${k}`), {
              displayName: m.name,
              kind: "person",
              memberIds: [],
              labels: [],
              interests: [],
              avoid: [],
              notes: null,
            })
          ).id
          made.set(k, id)
        }
        recipientIds.push(id)
      }
      let occasionId: string | null = null
      if (now.occasion !== null) {
        const k = `occasion:${fold(now.occasion.name)}`
        occasionId = now.occasion.ids[0] ?? made.get(k) ?? null
        if (occasionId === null) {
          occasionId = (
            await ledger.create("occasion", keyed(`import:${k}`), {
              kind: "custom",
              title: now.occasion.name,
              date: null,
              timeZone: null,
              year: null,
              currency: now.currency ?? options.currency,
              budgetMinor: null,
              groupIds: [],
              includeIds: [],
              excludeIds: [],
            })
          ).id
          made.set(k, occasionId)
        }
      }
      const allocates = occasionId !== null && recipientIds.length > 0
      const item = await ledger.create("item", keyed(`import:${seen.key}/item`), {
        title: now.title,
        url: now.url,
        productKey: null,
        variant: null,
        notes: now.notes,
        source: { kind: "import", ref: seen.key },
        planning: allocates ? "selected" : "idea",
        estimateMinor: now.priceMinor,
        currency: now.priceMinor === null ? null : now.currency,
      })
      out.itemId = item.id
      if (allocates && occasionId !== null) {
        const roster = await ledger.list("occasionRecipient", meta.ownerId, {
          ...all,
          occasionId,
        })
        for (const recipientId of recipientIds) {
          const row = roster.find((r) => r.recipientId === recipientId)
          if (row?.archived) {
            out.problems.push(`${recipientId} was taken off this occasion; left off its roster`)
          } else if (row === undefined) {
            await ledger.create(
              "occasionRecipient",
              keyed(`import:${seen.key}/roster/${recipientId}`),
              {
                occasionId,
                recipientId,
                target: null,
                budgetMinor: null,
                decision: "planning",
                skipReason: null,
              },
            )
          }
        }
        const allocation = await ledger.create(
          "allocation",
          keyed(`import:${seen.key}/allocation`),
          {
            itemId: item.id,
            occasionId,
            recipientIds,
            quantity: now.quantity,
            shared: false,
            purchaseId: null,
            handoff: "none",
            givenOn: null,
          },
        )
        out.allocationId = allocation.id
      }
      out.status = "applied"
    } catch (err) {
      out.status = "failed"
      out.problems.push(err instanceof Error ? err.message : String(err))
    }
  }
  return outcomes
}
