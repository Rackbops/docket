import type { Occurrence } from "./model.js"
import type { Store } from "./ports.js"

/**
 * Where an execute-lane run's Job stands, read from the run's own events, so it survives a
 * restart and every module that might cancel or skip a run can see it (plan 5.12). The dispatcher
 * writes these events and nothing else does.
 *
 * - A run whose Job is **submitted** has a call out at the runner. It is never cancelled as a
 *   scheduled run (`cancelScheduledRuns`), never dropped when its task completes, and it is
 *   collected and charged even when its task has since been paused, archived or completed. A
 *   done or archived task's late outcome is dropped, the charge kept; a paused task's is applied
 *   and its sends wait for the resume, as for any fired run of a paused task.
 * - A usage limit ends the Job for good (city-hall answers its key with the limit from then on), so
 *   the run's next try is a fresh Job under a new key.
 */

/** The event a run writes when the Executor says its Job is out and not finished. */
export const SUBMITTED_EVENT = "submitted: waiting for the runner"
/**
 * The marker event a run writes when its Job met the usage limit, and nothing else writes: each
 * one moves the run to a fresh Job key.
 */
export const USAGE_LIMIT_EVENT = "job ended at the usage limit"
/** The error event a run writes when its Job was given up after `PENDING_LIMIT_MS`. */
export const GAVE_UP_EVENT = "gave up waiting for the runner"

/**
 * The longest a submitted Job is waited for before its run is ended with an `error` result --
 * inferred, no plan item sets it: the spike's longest run took minutes (item 59), so six hours
 * means the runner or city-hall lost it. Counted from the submission, but a Job is only given up
 * on an answer -- pending, or an error that is not `ExecutorUnavailableError` -- so a Job that
 * finished while city-hall was unreachable is collected when it comes back, never given up. The
 * lane starts nothing new meanwhile.
 */
export const PENDING_LIMIT_MS = 6 * 3_600_000

/**
 * Pending this long, a Job is reported to the admins once (and noted on the run): the lane is
 * held for every owner while it is out. Inferred, like `PENDING_LIMIT_MS`.
 */
export const SLOW_JOB_MS = 3_600_000

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
    if (e.text === USAGE_LIMIT_EVENT) {
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
