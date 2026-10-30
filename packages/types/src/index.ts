/**
 * @rackbops/docket-types -- the tracker's task types, built on @rackbops/docket-core.
 *
 * The six categories of the plan (section 1.2) as type identifiers, and the types shipped so far:
 * `reminder` with the reminder slice (Lepid-Labs/city-hall#7), `renewal` and `price` with the
 * renewal and price-tracker slice (Lepid-Labs/city-hall#11), and `research` (category 5, E8), the
 * first execute-lane type: a research run and a reviewer run through the runner. `scout` (category
 * 1), `wantlist` and the judged `wantjudge` (category 2) came from the tracker plugin in 0.6.0 (E9,
 * plan item 104). `news` (category 1, plan item 153) watches one subject for new items, each
 * batch checked by a reviewer run before it is sent.
 */

import type { TaskType } from "@rackbops/docket-core"
import { news } from "./news.js"
import { price } from "./price.js"
import { reminder } from "./reminder.js"
import { renewal } from "./renewal.js"
import { research } from "./research.js"
import { scout } from "./scout.js"
import { pageSource } from "./want-sources.js"
import { wantjudgeType } from "./wantjudge.js"
import { wantlistType } from "./wantlist.js"

export type { Lane } from "@rackbops/docket-core"
export {
  type ExtractedPrice,
  extractPrice,
  jsonLdBlocks,
  MAX_PATTERN_BODY_CHARS,
  MAX_PATTERN_CHARS,
  parsePrice,
  patternProblem,
  priceFromJson,
  priceFromMeta,
  priceFromPattern,
} from "./extract.js"
export {
  checkDraft,
  INTAKE_ALLOWED_TOOLS,
  INTAKE_MAX_BUDGET_USD,
  INTAKE_MAX_TURNS,
  INTAKE_SCHEMA,
  INTAKE_STATES,
  INTAKE_TIMEOUT_MS,
  type IntakeAnswer,
  type IntakeContext,
  type IntakeDraft,
  type IntakeField,
  type IntakeLine,
  type IntakeRead,
  type IntakeState,
  type IntakeTask,
  type IntakeType,
  type IntakeValue,
  intakeJob,
  MAX_LINE_CHARS,
  MAX_REPLY_CHARS,
  MAX_TRANSCRIPT_CHARS,
  readIntake,
  transcriptLines,
} from "./intake.js"
export { currencyCode, money } from "./money.js"
export {
  LOOKBACK_DAYS,
  MAX_DISAMBIGUATE_CHARS,
  MAX_INCLUDE,
  MAX_KIND_CHARS,
  MAX_NEWS_ITEMS,
  MAX_SEEN,
  MAX_SUBJECT_CHARS,
  NEWS_MAX_BUDGET_USD,
  NEWS_MAX_TURNS,
  NEWS_REVIEW_MAX_BUDGET_USD,
  NEWS_REVIEW_MAX_TURNS,
  NEWS_REVIEW_SCHEMA,
  NEWS_SCHEMA,
  type NewsConfig,
  type NewsItem,
  type NewsPhase,
  type NewsShow,
  type NewsState,
  news,
  newsJob,
  newsKeys,
  newsReviewJob,
  newsState,
  PROMPT_SEEN,
  parseNews,
  parseNewsReview,
  renderNews,
  titleKey,
} from "./news.js"
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
  MIN_SOURCES_WAIT_MS,
  RESEARCH_MAX_BUDGET_USD,
  RESEARCH_MAX_TURNS,
  RESEARCH_TIMEOUT_MS,
  REVIEW_MAX_BUDGET_USD,
  REVIEW_MAX_TURNS,
  REVIEW_TIMEOUT_MS,
  type ResearchConfig,
  type ResearchJobOptions,
  type ResearchOptions,
  type ResearchPhase,
  type ResearchState,
  research,
  researchJob,
  researchState,
  researchType,
  reviewJob,
  usesSentSources,
} from "./research.js"
export {
  ANSWER_SCHEMA,
  type BlockedPage,
  clean,
  fitMessage,
  MAX_BLOCKED,
  MAX_MESSAGE_CHARS,
  parseAnswer,
  parseBlocked,
  parseReview,
  REVIEW_SCHEMA,
  type ResearchAnswer,
  type ResearchFinding,
  type Review,
  renderAnswer,
  renderUpdate,
  safeUrl,
  VERDICTS,
  type Verdict,
  ZWSP,
} from "./research-answer.js"
export {
  BARRED_SITES,
  blockedKey,
  GATHERED_ALLOWED_TOOLS,
  GATHERED_DENIED_TOOLS,
  type GatheredPage,
  gatheredPages,
  MAX_GATHERED_CHARS,
  MAX_GATHERED_PAGES,
  MAX_PAGE_CHARS,
  MAX_PAGE_TITLE_CHARS,
  MIN_PAGE_CHARS,
  NOT_OPENED_WHY,
  pagesBlock,
  pagesJson,
  type ReadSources,
  SENT_DISALLOWED_TOOLS,
  SOURCES_DEADLINE_MARGIN_MINUTES,
  SOURCES_DEADLINE_MARGIN_MS,
  SOURCES_WAIT_DAYS,
  SOURCES_WAIT_MS,
  sourcesExpiry,
  uniqueBlocked,
  WEB_DISALLOWED_TOOLS,
  withBarredSites,
} from "./research-sources.js"
export {
  BGG_CATEGORIES,
  bggCategoryUrl,
  FIRECRAWL_TOOLS,
  WEB_ALLOWED_TOOLS,
} from "./research-web.js"
export { RETRIED, type Retry, retryOutcome } from "./retry.js"
export {
  itemKey,
  LENS_TEXT,
  LENSES,
  type Lens,
  lensOf,
  MAX_FOR_CHARS,
  MAX_INTEREST_CHARS,
  MAX_INTERESTS,
  MAX_ITEMS,
  MAX_SCOUT_NOTES,
  MAX_SHOWN,
  MIN_ITEMS,
  PROMPT_SHOWN,
  parseScout,
  renderScout,
  SCOUT_MAX_BUDGET_USD,
  SCOUT_MAX_TURNS,
  SCOUT_SCHEMA,
  SCOUT_TIMEOUT_MS,
  type ScoutConfig,
  type ScoutItem,
  type ScoutState,
  type ShownItem,
  scout,
  scoutJob,
  scoutState,
} from "./scout.js"
export {
  BGG_ATTRIBUTION,
  BGG_HOST,
  BGG_SPACING_MS,
  type BggOptions,
  bggSource,
  bggThingUrl,
  MAX_SCANNED,
  parseBggThingId,
  parseMarketplace,
} from "./want-bgg.js"
export {
  DETAIL_CHARS,
  EBAY_ATTRIBUTION,
  EBAY_CURRENCY,
  EBAY_ITEM_ID,
  EBAY_ITEM_PATH,
  EBAY_LIMIT,
  EBAY_MARKETPLACE,
  EBAY_SEARCH_PATH,
  type EbayBrowse,
  type EbayRequest,
  type EbaySearch,
  ebayItemRequest,
  ebayRequest,
  ebaySource,
  parseEbayAnswer,
  parseEbayItem,
} from "./want-ebay.js"
export {
  matchesWords,
  minorUnits,
  parseShopifyAnswer,
  SHOPIFY_ATTRIBUTION,
  SHOPIFY_CAPABILITY,
  SHOPIFY_COUNTRY,
  SHOPIFY_CREDITS,
  SHOPIFY_CURRENCY,
  SHOPIFY_LIMIT,
  SHOPIFY_PROVIDER,
  type ShopifyRequest,
  type ShopifyScrape,
  type ShopifySearch,
  searchWords,
  shopifyQuery,
  shopifyRequest,
  shopifySource,
} from "./want-shopify.js"
export {
  inboxSource,
  isEbayHost,
  type Listing,
  type ListingDetail,
  listingKey,
  MAX_LISTINGS,
  NEVER_EBAY,
  pageSource,
  type ReadInbox,
  readListings,
  type SearchLimits,
  SOURCE_IDS,
  type Source,
  type SourceId,
  SourceMiss,
  SourceUnavailableError,
  type Submitted,
  submittedListing,
} from "./want-sources.js"
export { SOURCE_TEXT, type SourceText, sourceText } from "./want-text.js"
export {
  FITS,
  type Fit,
  JUDGE_MAX_BUDGET_USD,
  JUDGE_MAX_TURNS,
  JUDGE_SCHEMA,
  JUDGE_TIMEOUT_MS,
  type JudgeOptions,
  type JudgeState,
  type JudgeVerdict,
  judgeHosts,
  judgeJob,
  judgeState,
  parseVerdicts,
  RETRY_GRACE_MS,
  renderJudged,
  renderUnchecked,
  wantjudgeType,
} from "./wantjudge.js"
export {
  checkMark,
  clip,
  confirmListings,
  EXCLUDE_CHARS,
  hasConfirm,
  inert,
  isExcluded,
  keepsFindings,
  listingFinding,
  listingLine,
  MAX_DM_CHARS,
  MAX_EXCLUDE,
  MAX_NEW_PER_RUN,
  MAX_REPORTED,
  miss,
  moreLine,
  type Polled,
  parseExclude,
  pollWant,
  priceText,
  renderWant,
  SHOWN_IN_DM,
  type WantConfig,
  type WantState,
  wanted,
  wantlistType,
  wantState,
  withinLimits,
} from "./wantlist.js"

/**
 * The six task categories the tracker starts with (plan section 1.2), as type identifiers, then
 * `wantjudge`: category 2's watch with the model's look first (plan 5.4), a type of its own.
 */
export const TYPE_IDS = [
  "reminder",
  "renewal",
  "price",
  "research",
  "scout",
  "wantlist",
  "wantjudge",
  "news",
] as const

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
  scout: scout as TaskType<unknown>,
  // Over the page source only: BGG needs a host's token, so a host with one builds its own.
  wantlist: wantlistType({ page: pageSource }) as TaskType<unknown>,
  wantjudge: wantjudgeType({ page: pageSource }) as TaskType<unknown>,
  news: news as TaskType<unknown>,
})
