/**
 * What a task type may do beyond observing (plan sections 1.3 and 5.6). The grantable set holds
 * tier 0 and tier 1 members only: tier 2 (buy, bid, mail a third party, act on an outside account)
 * has no name here on purpose, so nothing speculative can be declared, granted or built before its
 * own design pass. `defineTaskType` refuses a type that declares anything outside this list, and a
 * test in docket-types asserts it over every shipped type.
 *
 * A capability here is a side-effect grant (plan 5.6), not city-hall's "capability tag", which
 * names the kind of agent a task needs (RQ-003). The naming clash is open with plan item 43
 * (Nazu's to agree); the plan says "capability tag" only for city-hall's sense. `graph:write` was
 * for recall and has no consumer since item 37; whether it stays is a follow-up.
 */
export const CAPABILITIES = ["notify", "graph:write", "discord:post", "github:issue"] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Tier 0 is always available; tier 1 is granted per type by an admin and narrowable per task. */
export const CAPABILITY_TIER: Readonly<Record<Capability, 0 | 1>> = {
  notify: 0,
  "graph:write": 1,
  "discord:post": 1,
  "github:issue": 1,
}

/** True when `value` names a grantable capability. */
export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value)
}

/** The names in `declared` that are not grantable. Empty means the declaration is clean. */
export function unknownCapabilities(declared: readonly string[]): string[] {
  return declared.filter((c) => !isCapability(c))
}
