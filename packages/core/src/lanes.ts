/**
 * The two drains a task type runs on (plan section 5.3). The notify lane ticks every minute and
 * never waits on a model; the execute lane runs model Jobs, serially, through the runner. A lane
 * whose runtime is missing is skipped, never drained to a halt (city-hall#7).
 */
export const LANES = ["notify", "execute"] as const

export type Lane = (typeof LANES)[number]

/** True when `value` names a lane. Narrows a string read from storage or the wire. */
export function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value)
}
