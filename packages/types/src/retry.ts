import type { FailureKind } from "@rackbops/docket-core"

/**
 * The retry policy the model-run types share (research, scout, want judge; docket#67): which
 * failures retry, how many tries a phase gets, and how long an auth failure waits. A change to
 * any of them lands in all three at once.
 */

/** Tries per phase: the first, and one retry. */
export const MAX_TRIES = 2
/** How long an auth failure waits before its one retry. */
export const AUTH_RETRY_MS = 3_600_000

/** The failures worth one more try; a cap or a usage limit would fail the same way again. */
export const RETRIED: ReadonlySet<FailureKind | "malformed"> = new Set<FailureKind | "malformed">([
  "schema_miss",
  "malformed",
  "timeout",
  "error",
  "auth_failed",
])

/** When a retry runs: `at`, and the follow-up that asks for it (empty: as soon as may be). */
export interface Retry {
  at: string
  followUp: { at?: string }
}

/**
 * The retry for a failure of `kind` that makes `failures` tries so far, or null when it is not
 * retried (not in `RETRIED`, or the tries are spent). An auth failure waits `AUTH_RETRY_MS`;
 * anything else retries at once.
 */
export function retryOutcome(
  kind: FailureKind | "malformed",
  failures: number,
  now: Date,
): Retry | null {
  if (!RETRIED.has(kind) || failures >= MAX_TRIES) return null
  const wait = kind === "auth_failed" ? AUTH_RETRY_MS : 0
  const at = new Date(now.getTime() + wait).toISOString()
  return { at, followUp: wait > 0 ? { at } : {} }
}
