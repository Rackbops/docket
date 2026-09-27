/**
 * @rackbops/docket-types -- the tracker's task types, built on @rackbops/docket-core.
 *
 * The six categories of the plan (section 1.2) as type identifiers, and the types shipped so far:
 * `reminder` with the reminder slice (Lepid-Labs/city-hall#7). The others land with their epics
 * (#11: renewal, price; #13: scout, wantlist; research with E8).
 */

import type { TaskType } from "@rackbops/docket-core"
import { reminder } from "./reminder.js"

export type { Lane } from "@rackbops/docket-core"
export { DEFAULT_SNOOZE_MS, type ReminderConfig, reminder, snoozeUntil } from "./reminder.js"

/** The six task categories the tracker starts with (plan section 1.2), as type identifiers. */
export const TYPE_IDS = ["reminder", "renewal", "price", "research", "scout", "wantlist"] as const

export type TypeId = (typeof TYPE_IDS)[number]

/** True when `value` names a task type. Narrows a string read from storage or the wire. */
export function isTypeId(value: string): value is TypeId {
  return (TYPE_IDS as readonly string[]).includes(value)
}

/** Every shipped type, keyed by id, ready for the dispatcher's `types`. */
export const TASK_TYPES: Readonly<Record<string, TaskType<unknown>>> = Object.freeze({
  reminder: reminder as TaskType<unknown>,
})
