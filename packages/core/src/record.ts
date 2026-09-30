import type { Occurrence, ReplyKind, RunRecord } from "./model.js"

/**
 * A run's record (`Occurrence.record`), read back. The dispatcher is its only writer, but the
 * row lives in a host's store, so what comes back is checked field by field and anything that
 * does not have the shape the dispatcher writes is treated as no record at all: a run is never
 * resumed, and nothing is ever delivered, from a value the dispatcher did not produce.
 */

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const optional = (o: Obj, k: string, check: (v: unknown) => boolean) =>
  o[k] === undefined || check(o[k])
const isString = (v: unknown) => typeof v === "string"
const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v)
const isStringArray = (v: unknown) => Array.isArray(v) && v.every(isString)

const REPLY_KINDS: ReadonlySet<ReplyKind> = new Set([
  "accept",
  "decline",
  "opt_out",
  "done",
  "snooze",
  "decision",
  "text",
])

function isMessage(v: unknown): boolean {
  if (!isObj(v) || !isString(v.text)) return false
  const actions = v.actions
  if (
    actions !== undefined &&
    !(Array.isArray(actions) && actions.every((a) => REPLY_KINDS.has(a as ReplyKind)))
  ) {
    return false
  }
  // A stored message never carries a reply reference: `deliver` sets it on each copy.
  return optional(v, "decisions", isStringArray) && v.ref === undefined
}

function isSeries(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (p) =>
        isObj(p) &&
        isNumber(p.value) &&
        optional(p, "unit", isString) &&
        optional(p, "note", isString) &&
        optional(p, "at", isString),
    )
  )
}

function isFindings(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (f) =>
        isObj(f) &&
        isString(f.text) &&
        optional(f, "tags", isStringArray) &&
        optional(f, "source", isString),
    )
  )
}

function isOutcome(v: unknown): boolean {
  return (
    isObj(v) &&
    v.snoozeUntil === undefined &&
    optional(v, "notify", isMessage) &&
    optional(v, "summary", isString) &&
    optional(v, "series", isSeries) &&
    optional(v, "complete", (c) => typeof c === "boolean") &&
    optional(v, "findings", isFindings)
  )
}

/** The record, or null when there is none or it is not one the dispatcher wrote. */
export function parseRunRecord(value: unknown): RunRecord | null {
  if (!isObj(value)) return null
  const ok =
    isOutcome(value.outcome) &&
    (value.costUsd === null || isNumber(value.costUsd)) &&
    isString(value.firedAt) &&
    (value.appliedAt === null || isString(value.appliedAt)) &&
    Number.isInteger(value.resumes)
  return ok ? (value as unknown as RunRecord) : null
}

/**
 * Whether the run has fired: a record is stored. Any record counts here, well-formed or not, so a
 * run that fired is never cancelled or re-run on the strength of a record that failed to parse.
 */
export function hasFired(occurrence: Occurrence): boolean {
  return occurrence.record !== null && occurrence.record !== undefined
}
