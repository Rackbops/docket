/**
 * @rackbops/docket-core -- the tracker's domain, scheduler, task-type contract and ports.
 *
 * This is the scaffold (Rackbops/docket#1): one real export so the workspace, the build, the
 * tests and the publish path can be proven end to end. The domain lands per
 * Lepid-Labs/city-hall#7. Design: Rackbops/Tooling, research/city-hall-task-tracker.md, section 5.
 */

/**
 * The two drains a task type runs on (plan section 5.3). The notify lane ticks every minute and
 * never waits on a model; the execute lane runs model Jobs, serially, through the runner.
 */
export const LANES = ["notify", "execute"] as const

export type Lane = (typeof LANES)[number]

/** True when `value` names a lane. Narrows a string read from storage or the wire. */
export function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value)
}
