/**
 * @rackbops/docket-types -- the tracker's task types, built on @rackbops/docket-core.
 *
 * The six categories of the plan (section 1.2) as type identifiers, and the types shipped so far:
 * `reminder` with the reminder slice (Lepid-Labs/city-hall#7), `renewal` and `price` with the
 * renewal and price-tracker slice (city-hall#11), and `research` (category 5, E8), the first
 * execute-lane type: a research run and a reviewer run through the runner. The others land with
 * their epics (#13: scout, wantlist).
 */

import type { TaskType } from "@rackbops/docket-core"
import { price } from "./price.js"
import { reminder } from "./reminder.js"
import { renewal } from "./renewal.js"
import { research } from "./research.js"

export type { Lane } from "@rackbops/docket-core"
export {
  type ExtractedPrice,
  extractPrice,
  jsonLdBlocks,
  parsePrice,
  priceFromJson,
  priceFromMeta,
  priceFromPattern,
} from "./extract.js"
export { money } from "./money.js"
export {
  BASELINE_RULES,
  type BaselineRule,
  DEFAULT_BASELINE,
  DEFAULT_DROP_PERCENT,
  MISSES_BEFORE_TELLING,
  type PriceConfig,
  type PriceState,
  price,
  reference,
} from "./price.js"
export { DEFAULT_SNOOZE_MS, type ReminderConfig, reminder, snoozeUntil } from "./reminder.js"
export {
  decisionOf,
  isRenewalDecision,
  RENEWAL_DECISIONS,
  type RenewalConfig,
  type RenewalDecision,
  type RenewalState,
  renewal,
} from "./renewal.js"

export {
  AUTH_RETRY_MS,
  deadlineOf,
  draftJson,
  MAX_CONTEXT_CHARS,
  MAX_QUESTION_CHARS,
  MAX_TRIES,
  RESEARCH_MAX_BUDGET_USD,
  RESEARCH_MAX_TURNS,
  RESEARCH_TIMEOUT_MS,
  REVIEW_MAX_BUDGET_USD,
  REVIEW_MAX_TURNS,
  REVIEW_TIMEOUT_MS,
  type ResearchConfig,
  type ResearchPhase,
  type ResearchState,
  research,
  researchJob,
  researchState,
  reviewJob,
} from "./research.js"
export {
  ANSWER_SCHEMA,
  clean,
  fitMessage,
  MAX_MESSAGE_CHARS,
  parseAnswer,
  parseReview,
  REVIEW_SCHEMA,
  type ResearchAnswer,
  type ResearchFinding,
  type Review,
  renderAnswer,
  safeUrl,
  VERDICTS,
  type Verdict,
  ZWSP,
} from "./research-answer.js"

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
  renewal: renewal as TaskType<unknown>,
  price: price as TaskType<unknown>,
  research: research as TaskType<unknown>,
})
