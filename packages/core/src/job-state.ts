import type { Occurrence } from "./model.js"
import type { Store } from "./ports.js"

/**
 * Where an execute-lane run's Job stands, read from the run's own events, so it survives a
 * restart and every module that might cancel or skip a run can see it (plan 5.12). The dispatcher
 * writes these events and nothing else does.
 *
 * - A run whose Job is **submitted** has a call out at the runner. It is never cancelled as a
 *   scheduled run (`cancelScheduledRuns`), never dropped when its task completes, and it is
 *   collected and charged even when its task has since been paused, archived or completed; the
 *   outcome of such a late collection is dropped, the charge stays.
 * - A usage limit ends the Job for good (city-hall answers its key with the limit from then on), so
 *   the run's next try is a fresh Job under a new key.
 */

/** The event a run writes when the Executor says its Job is out and not finished. */
export const SUBMITTED_EVENT = "submitted: waiting for the runner"
/** The event a run writes when its Job met the usage limit; the reset time follows it. */
export const USAGE_LIMIT_EVENT = "waiting: usage limit"
/** The error event a run writes when its Job was given up after `PENDING_LIMIT_MS`. */
export const GAVE_UP_EVENT = "gave up waiting for the runner"

/**
 * The longest a submitted Job is waited for before its run is ended with an `error` result --
 * inferred, no plan item sets it: the spike's longest run took minutes (item 59), so six hours
 * means the runner or city-hall lost it, and holding the lane longer would starve every owner.
 */
export const PENDING_LIMIT_MS = 6 * 3_600_000

export interface JobState {
  /** The key the run's current Job is submitted under: the occurrence id, then `<id>:<n>`. */
  key: string
  /** Whether that Job is out and not yet answered. */
  submitted: boolean
  /** When it was submitted; null when it is not. */
  submittedAt: string | null
}

/** The run's Job, from its events. */
export async function jobState(store: Store, occurrence: Occurrence): Promise<JobState> {
  let limits = 0
  let submittedAt: string | null = null
  for (const e of await store.listEvents(occurrence.id)) {
    if (e.agent !== DISPATCHER || e.type !== "status") continue
    if (e.text.startsWith(USAGE_LIMIT_EVENT)) {
      limits++
      submittedAt = null
    } else if (e.text === SUBMITTED_EVENT) submittedAt = e.at
  }
  return {
    key: limits === 0 ? occurrence.id : `${occurrence.id}:${limits}`,
    submitted: submittedAt !== null,
    submittedAt,
  }
}

/** Whether a queued, unfired run has a Job out: one no cancel may delete. */
export async function hasJobOut(store: Store, occurrence: Occurrence): Promise<boolean> {
  return occurrence.lane === "execute" && (await jobState(store, occurrence)).submitted
}

/** The `agent` the dispatcher writes its events as. */
export const DISPATCHER = "docket"
