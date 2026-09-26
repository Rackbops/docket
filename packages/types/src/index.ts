/**
 * @rackbops/docket-types -- the tracker's task types, built on @rackbops/docket-core.
 *
 * This is the scaffold (Rackbops/docket#1): the type identifiers and nothing else, so the
 * workspace dependency on docket-core is exercised by the build, the tests and the publish path.
 * The types themselves land with their epics (Lepid-Labs/city-hall#7, #11, #13).
 */

export type { Lane } from "@rackbops/docket-core"

/** The six task categories the tracker starts with (plan section 1.2), as type identifiers. */
export const TYPE_IDS = ["reminder", "renewal", "price", "research", "scout", "wantlist"] as const

export type TypeId = (typeof TYPE_IDS)[number]

/** True when `value` names a task type. Narrows a string read from storage or the wire. */
export function isTypeId(value: string): value is TypeId {
  return (TYPE_IDS as readonly string[]).includes(value)
}
