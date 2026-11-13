/**
 * A research answer as data (plan 5.6): what the model returned is parsed field by field, capped,
 * and cleaned before any of it becomes message text or a finding. Nothing here trusts the shape
 * the JSON schema promised -- the CLI enforces it, but a stored draft comes back from the task's
 * state, and a reviewer could return a valid shape around hostile text. A page the agent read can
 * carry an instruction; the most it can do here is be quoted as text.
 */

import { clean, ZWSP } from "@rackbops/docket-core"
import {
  canonicalSocialUrl,
  isSocialPlatform,
  platformName,
  platformOf,
  SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "./social-links.js"

/** The cleaner lives in core, so the dispatcher's own messages use it too; re-exported here. */
export { clean, ZWSP }

/** One claim and the pages it rests on. */
export interface ResearchFinding {
  claim: string
  /**
   * http(s) URLs the run says it opened; a social post link as one post (`canonicalSocialUrl`,
   * 0.23.0), so a repost counts once.
   */
  sources: string[]
  /**
   * The platform the sources are posts on (0.23.0), as the run set it or as every source's host
   * says; absent for a web page. The two fields below are kept only with it.
   */
  platform?: SocialPlatform
  /** When the post was published, as the run read it: an instant, "about <date>", or "undated". */
  publishedAt?: string
  /** `read`: the transcript, the comments or the post itself was opened; `snippet`: a caption or a search result only. */
  evidence?: "read" | "snippet"
}

/** What a run did on one platform (0.23.0): the DM's "Social:" line is built from these. */
export const COVERAGE_STATUSES = ["searched", "empty", "unavailable", "skipped"] as const

export type CoverageStatus = (typeof COVERAGE_STATUSES)[number]

export interface Coverage {
  /** The platform's id, lower-cased: youtube, tiktok, instagram, bluesky, reddit, or another. */
  platform: string
  status: CoverageStatus
  /** A few words: what was found, or why not. */
  note?: string
}

/**
 * A page the run needed but could not open (0.9.0): refused, a 403, a CAPTCHA, a sign-in wall.
 * What the person's own browser could gather for a fuller pass.
 */
export interface BlockedPage {
  site: string
  /** An http(s) URL, when the run had one. */
  url?: string
  why: string
}

/** The shape both runs return (the reviewer inside its verdict). */
export interface ResearchAnswer {
  summary: string
  findings: ResearchFinding[]
  uncertain: string[]
  /** Pages the run needed but could not open; absent when there were none. Never rendered. */
  blocked?: BlockedPage[]
  /**
   * What the run did on each social platform (0.23.0); absent when none was in scope. Rendered
   * as the DM's "Social:" line.
   */
  coverage?: Coverage[]
}

export const MAX_SUMMARY_CHARS = 1200
export const MAX_CLAIM_CHARS = 400
export const MAX_URL_CHARS = 400
export const MAX_FINDINGS = 12
export const MAX_SOURCES_PER_FINDING = 4
export const MAX_UNCERTAIN = 6
export const MAX_UNCERTAIN_CHARS = 300
export const MAX_BLOCKED = 6
export const MAX_BLOCKED_SITE_CHARS = 100
export const MAX_BLOCKED_WHY_CHARS = 200
/** A post's `publishedAt` as kept: an instant, "about 2026-10-19" or "undated" all fit. */
export const MAX_PUBLISHED_CHARS = 40
export const MAX_COVERAGE = 8
export const MAX_COVERAGE_PLATFORM_CHARS = 30
export const MAX_COVERAGE_NOTE_CHARS = 120
/** The DM's "Social:" line, kept whole like the "Couldn't open:" tail, so it is bounded here. */
export const MAX_COVERAGE_LINE_CHARS = 500
/** Discord's DM limit is 2000 characters; the rest is headroom for the host's own framing. */
export const MAX_MESSAGE_CHARS = 1900
/**
 * A finding's claim in the DM's compact form (docket#126): enough to tell what the finding is,
 * the rest on the task's page.
 */
export const MAX_COMPACT_CLAIM_CHARS = 100

/** The JSON schema the research run answers in: the spike's (docket-runner spike/cases.json). */
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "The answer in at most 150 words." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "string",
              description: "A URL you opened; for a post marked snippet, the post's own page.",
            },
          },
          platform: {
            type: "string",
            enum: [...SOCIAL_PLATFORMS],
            description:
              "For a finding from a social post: the platform it is on. Leave it out for a web " +
              "page.",
          },
          publishedAt: {
            type: "string",
            description:
              "For a finding from a post: when it was published -- the instant the platform " +
              'gave, "about <date>" worked out from a relative time, or "undated".',
          },
          evidence: {
            type: "string",
            enum: ["read", "snippet"],
            description:
              "For a finding from a post: read when you opened the transcript, the comments or " +
              "the post itself; snippet when you have only its caption or a search result.",
          },
        },
        required: ["claim", "sources"],
      },
    },
    uncertain: { type: "array", items: { type: "string" } },
    blocked: {
      type: "array",
      description:
        "Pages you needed but could not open (refused, 403, CAPTCHA, sign-in wall), and the " +
        "best source for a part that you could not or may not open; leave it out or empty " +
        "when there were none.",
      items: {
        type: "object",
        properties: {
          site: { type: "string", description: "The site, such as boardgamegeek.com." },
          url: { type: "string", description: "The page's URL, if you had one." },
          why: { type: "string", description: "What stopped you, in a few words." },
        },
        required: ["site", "why"],
      },
    },
    coverage: {
      type: "array",
      description:
        "When social platforms were in scope: one entry per platform, and one for Reddit; " +
        "leave it out otherwise.",
      items: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            description: "youtube, tiktok, instagram, bluesky or reddit.",
          },
          status: {
            type: "string",
            enum: [...COVERAGE_STATUSES],
            description:
              "searched: something found; empty: nothing found; unavailable: the call failed " +
              "(say which); skipped: not searched (say why).",
          },
          note: { type: "string", description: "A few words: what was found, or why not." },
        },
        required: ["platform", "status"],
      },
    },
  },
  required: ["summary", "findings", "uncertain"],
} as const

/** An http(s) URL, as a URL parses it, or null. Never anything else (no `javascript:`). */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().replace(/^<|>$/g, "")
  if (trimmed.length === 0 || trimmed.length > MAX_URL_CHARS) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password) return null
  const text = url.toString()
  const decoded = decodeURIComponentSafe(text)
  // A URL is shown as is, so one that spells a mention could ping; it is no source.
  if (/@(everyone|here)\b|<[@#]/i.test(decoded)) return null
  // Nor one that closes a masked link (`](`): beside a claim that opens one with `[`, it would
  // render as a link to whatever follows, the pattern `clean` breaks in text.
  if (decoded.includes("](")) return null
  return text
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * The platform every source of a finding is on, when they agree (0.23.0); null when any is a web
 * page, or they differ.
 */
function platformOfAll(sources: readonly string[]): SocialPlatform | null {
  const platforms = new Set(sources.map(platformOf))
  const [only] = platforms
  return platforms.size === 1 && only ? only : null
}

/**
 * A finding's post fields (0.23.0): `platform` as the run set it (one of `SOCIAL_PLATFORMS`, and
 * a source is on it) or as every source's host says; with one, `publishedAt` (one line, capped)
 * and `evidence` when usable. A finding on web pages alone gets none, whatever the run set.
 */
function postFields(
  f: Record<string, unknown>,
  sources: readonly string[],
): Pick<ResearchFinding, "platform" | "publishedAt" | "evidence"> {
  const given =
    isSocialPlatform(f.platform) && sources.some((u) => platformOf(u) === f.platform)
      ? f.platform
      : null
  const platform = given ?? platformOfAll(sources)
  if (!platform) return {}
  const when =
    typeof f.publishedAt === "string" ? clean(f.publishedAt, MAX_PUBLISHED_CHARS, true) : ""
  return {
    platform,
    ...(when.length > 0 ? { publishedAt: when } : {}),
    ...(f.evidence === "read" || f.evidence === "snippet" ? { evidence: f.evidence } : {}),
  }
}

/**
 * The answer in `value`, capped and cleaned, or null when it is not one. A claim with no usable
 * source is not a finding: it moves to `uncertain`, marked, since every claim a reader might act
 * on needs a source the run opened. A source on a social platform is kept as one post
 * (`canonicalSocialUrl`), so a `youtu.be` link and its watch page are one (0.23.0).
 */
export function parseAnswer(value: unknown): ResearchAnswer | null {
  if (!isObj(value) || typeof value.summary !== "string" || !Array.isArray(value.findings)) {
    return null
  }
  const summary = clean(value.summary, MAX_SUMMARY_CHARS)
  if (summary.length === 0) return null
  const findings: ResearchFinding[] = []
  const unsourced: string[] = []
  for (const f of value.findings) {
    if (!isObj(f) || typeof f.claim !== "string") continue
    const claim = clean(f.claim, MAX_CLAIM_CHARS, true)
    if (claim.length === 0) continue
    const raw = Array.isArray(f.sources) ? f.sources : []
    const sources = [
      ...new Set(
        raw
          .map(safeUrl)
          .filter((u): u is string => u !== null)
          .map(canonicalSocialUrl),
      ),
    ]
    if (sources.length === 0) unsourced.push(`${claim} (no source given)`)
    else {
      const kept = sources.slice(0, MAX_SOURCES_PER_FINDING)
      findings.push({ claim, sources: kept, ...postFields(f, kept) })
    }
  }
  // The model's own lines come first, so the cap drops markers before them: `withBarredSites`
  // reads these lines to tell a site was not opened.
  const uncertain: string[] = []
  const said = Array.isArray(value.uncertain) ? value.uncertain : []
  for (const u of said) {
    if (typeof u !== "string") continue
    const line = clean(u, MAX_UNCERTAIN_CHARS, true)
    if (line.length > 0) uncertain.push(line)
  }
  uncertain.push(...unsourced)
  const blocked = parseBlocked(value.blocked)
  const coverage = parseCoverage(value.coverage)
  return {
    summary,
    findings: findings.slice(0, MAX_FINDINGS),
    uncertain: uncertain.slice(0, MAX_UNCERTAIN),
    ...(blocked.length > 0 ? { blocked } : {}),
    ...(coverage.length > 0 ? { coverage } : {}),
  }
}

/**
 * The coverage rows in `value` (0.23.0), cleaned: a lower-cased one-line platform id, a status in
 * `COVERAGE_STATUSES`, a one-line note when given; the first row per platform, at most
 * `MAX_COVERAGE`. A row with no platform or an unknown status is dropped; anything not a list is
 * none.
 */
export function parseCoverage(value: unknown): Coverage[] {
  if (!Array.isArray(value)) return []
  const out: Coverage[] = []
  for (const c of value) {
    if (out.length >= MAX_COVERAGE) break
    if (!isObj(c) || typeof c.platform !== "string" || typeof c.status !== "string") continue
    const platform = clean(c.platform, MAX_COVERAGE_PLATFORM_CHARS, true).toLowerCase()
    const status = (COVERAGE_STATUSES as readonly string[]).includes(c.status)
      ? (c.status as CoverageStatus)
      : null
    if (platform.length === 0 || !status || out.some((o) => o.platform === platform)) continue
    const note = typeof c.note === "string" ? clean(c.note, MAX_COVERAGE_NOTE_CHARS, true) : ""
    out.push({ platform, status, ...(note.length > 0 ? { note } : {}) })
  }
  return out
}

/** A claim as compared for repeats: case, spacing and a trailing stop do not count. */
export function sameClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "")
}

/**
 * The blocked pages in `value`, cleaned: a one-line site and reason, the URL only when `safeUrl`
 * takes it, at most `MAX_BLOCKED`. An entry with no site is dropped; anything not a list is none.
 */
export function parseBlocked(value: unknown): BlockedPage[] {
  if (!Array.isArray(value)) return []
  const out: BlockedPage[] = []
  for (const b of value) {
    if (out.length >= MAX_BLOCKED) break
    if (!isObj(b) || typeof b.site !== "string") continue
    const site = clean(b.site, MAX_BLOCKED_SITE_CHARS, true)
    if (site.length === 0) continue
    const why = typeof b.why === "string" ? clean(b.why, MAX_BLOCKED_WHY_CHARS, true) : ""
    const url = safeUrl(b.url)
    out.push({ site, ...(url ? { url } : {}), why })
  }
  return out
}

/** The reviewer's three verdicts. */
export const VERDICTS = ["approve", "revise", "reject"] as const

export type Verdict = (typeof VERDICTS)[number]

export interface Review {
  verdict: Verdict
  /** What the reviewer found wrong; empty on a clean approval. */
  problems: string[]
  /** The answer to send: the draft as approved, or as the reviewer corrected it. */
  answer: ResearchAnswer | null
}

export const MAX_PROBLEMS = 5
export const MAX_PROBLEM_CHARS = 300

/** The JSON schema the reviewer answers in. */
export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: [...VERDICTS],
      description:
        "approve: the draft stands as is. revise: it stands once corrected; put the corrected " +
        "answer in `answer`. reject: it cannot be fixed by editing (wrong question, sources do " +
        "not support it, or nothing usable).",
    },
    problems: {
      type: "array",
      items: { type: "string" },
      description: "Each problem found, one line each; empty when there are none.",
    },
    answer: {
      ...ANSWER_SCHEMA,
      description: "The corrected answer, on revise only; left out on approve and reject.",
    },
  },
  required: ["verdict", "problems"],
} as const

/**
 * The reviewer's verdict in `value`, cleaned, or null when it is not one. An `approve` whose
 * `answer` is missing or unusable takes `draft`: approving says the draft stands, and the type
 * sends the draft on approve anyway (a reviewer that skipped copying a long draft back failed
 * twice on t11, 2026-10-18).
 */
export function parseReview(value: unknown, draft?: ResearchAnswer): Review | null {
  if (!isObj(value) || typeof value.verdict !== "string") return null
  const verdict = (VERDICTS as readonly string[]).includes(value.verdict)
    ? (value.verdict as Verdict)
    : null
  if (!verdict) return null
  const problems = (Array.isArray(value.problems) ? value.problems : [])
    .filter((p): p is string => typeof p === "string")
    .map((p) => clean(p, MAX_PROBLEM_CHARS, true))
    .filter((p) => p.length > 0)
    .slice(0, MAX_PROBLEMS)
  const answer = parseAnswer(value.answer) ?? (verdict === "approve" ? (draft ?? null) : null)
  // Revise, or approve with no draft to fall back on, without a usable answer is not a verdict
  // the type can act on.
  if (verdict !== "reject" && !answer) return null
  return { verdict, problems, answer: verdict === "reject" ? null : answer }
}

/**
 * Fits `lines` into `max` characters: as they are when they fit, a text of exactly `max`
 * characters among them (docket#126 and docket#132 reviews); otherwise whole lines dropped from
 * the end, each kept line leaving room for the marker that says so.
 */
function fit(lines: string[], max: number): string {
  const whole = lines.join("\n")
  if (whole.length <= max) return whole
  const out: string[] = []
  let length = 0
  for (const [i, line] of lines.entries()) {
    const more = `(${lines.length - i} more lines not shown)`
    const sep = out.length > 0 ? 1 : 0
    // Room for this line, and for the marker unless it is the last.
    const reserve = i < lines.length - 1 ? more.length + 1 : 0
    if (length + sep + line.length + reserve > max) {
      out.push(more)
      break
    }
    out.push(line)
    length += sep + line.length
  }
  const text = out.join("\n")
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/** Lines as one DM of at most `MAX_MESSAGE_CHARS`, whole lines dropped from the end. */
export function fitMessage(lines: string[]): string {
  return fit(lines, MAX_MESSAGE_CHARS)
}

/** For a post: " (platform, date, snippet only)" as the DM marks it (0.23.0); "" for a web page. */
function postMarks(f: ResearchFinding): string {
  const parts = f.platform
    ? [
        platformName(f.platform),
        ...(f.publishedAt ? [f.publishedAt] : []),
        ...(f.evidence === "snippet" ? ["snippet only"] : []),
      ]
    : []
  return parts.length > 0 ? ` (${parts.join(", ")})` : ""
}

/**
 * A finding's line in a DM: the claim, for a post its platform, date and "snippet only" when it
 * was not opened (0.23.0), then its first source in <...> so Discord shows the link without an
 * embed.
 */
export function findingLine(f: ResearchFinding): string {
  return `- ${f.claim}${postMarks(f)} <${f.sources[0]}>`
}

/**
 * A finding's compact line (docket#126): the claim cut to `MAX_COMPACT_CLAIM_CHARS`, the post
 * marks, and no link, since the finding is on the task's page with it.
 */
export function compactFindingLine(f: ResearchFinding): string {
  const claim =
    f.claim.length > MAX_COMPACT_CLAIM_CHARS
      ? `${f.claim.slice(0, MAX_COMPACT_CLAIM_CHARS - 3).trimEnd()}...`
      : f.claim
  return `- ${claim}${postMarks(f)}`
}

/**
 * A headed block of a DM, to join after the lines before it, in `room` characters: the header
 * and as many of `lines` as fit, the rest counted by `more` in a last line; when not one fits,
 * the one line `alone` saying how many there were, never a bare header; nothing when even that
 * does not fit, and nothing for no lines. Each line costs its length and its newline.
 */
function fitBlock(
  header: string,
  lines: readonly string[],
  room: number,
  more: (n: number) => string,
  alone: (n: number) => string,
): string[] {
  if (lines.length === 0) return []
  const out = ["", header]
  let used = out.join("\n").length
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i - 1
    // Room for this line and, unless it is the last, for the count that would follow it.
    const reserve = rest > 0 ? more(rest).length + 1 : 0
    if (used + line.length + 1 + reserve > room) {
      if (i > 0) return [...out, more(lines.length - i)]
      const only = alone(lines.length)
      return only.length + 1 <= room ? ["", only] : []
    }
    out.push(line)
    used += line.length + 1
  }
  return out
}

/** The count line a findings block ends with when the compact lines do not all fit. */
const MORE_FINDINGS = (n: number) => `(${n} more on the task's page)`
/** The one line a findings block is when not one compact line fits. */
const FINDINGS_ALONE = (n: number) => `${n} finding(s) on the task's page.`
/** The count line an "Uncertain:" block ends with when the caveats do not all fit. */
const MORE_CAVEATS = (n: number) => `(${n} more not shown)`
/** The one line an "Uncertain:" block is when not one caveat fits. */
const CAVEATS_ALONE = (n: number) => `${n} caveat(s) not shown.`

/**
 * The DM's findings block in compact form (docket#126): `Findings:` (or `New or corrected:` for
 * a second pass, docket#132) and as many compact lines as fit in `room`, the rest counted; when
 * not one fits, one line saying how many are on the task's page, where every finding is saved.
 */
function compactFindings(
  findings: readonly ResearchFinding[],
  room: number,
  header = "Findings:",
): string[] {
  return fitBlock(header, findings.map(compactFindingLine), room, MORE_FINDINGS, FINDINGS_ALONE)
}

/**
 * The DM's "Uncertain:" block when the whole answer does not fit (docket#132): the header and as
 * many caveats as fit in `room`, the rest counted; when not one fits, one line saying how many
 * there were. The caveats are kept nowhere else, so the count says "not shown", not where to
 * read them.
 */
function fitCaveats(uncertain: readonly string[], room: number): string[] {
  const lines = uncertain.map((u) => `- ${u}`)
  return fitBlock("Uncertain:", lines, room, MORE_CAVEATS, CAVEATS_ALONE)
}

const STATUS_WORDS: Readonly<Record<CoverageStatus, string>> = {
  searched: "searched",
  empty: "nothing found",
  unavailable: "unavailable",
  skipped: "skipped",
}

/**
 * The DM's "Social:" line (0.23.0): each platform's status, with its note in brackets, in one
 * line of at most `MAX_COVERAGE_LINE_CHARS`.
 */
export function coverageLine(coverage: readonly Coverage[]): string {
  const items = coverage.map(
    (c) => `${platformName(c.platform)} ${STATUS_WORDS[c.status]}${c.note ? ` (${c.note})` : ""}`,
  )
  return clean(`Social: ${items.join("; ")}.`, MAX_COVERAGE_LINE_CHARS, true)
}

/**
 * The DM a reviewed answer goes out as, at most `MAX_MESSAGE_CHARS`. Every piece of it was
 * cleaned by `parseAnswer`; the title is the owner's own and is cleaned here. The "Social:" line
 * (0.23.0, when the answer has `coverage`), the reviewer's note and `tail` are kept whole, in
 * that order: `tail`, when given, is bounded by the caller (the "couldn't open" list and the
 * queued line, 0.9.0). Without coverage or a tail the DM is what it was before 0.9.0.
 *
 * When the whole answer fits, the findings come as full lines with their links. When it does
 * not (docket#126, docket#132), the room the whole parts leave goes, in this order, to the
 * summary (whole, or cut with an ellipsis, since the DM is the only place it reaches the owner,
 * and leaving room for the two counts below), to the `uncertain` lines (as many as fit, the rest
 * counted, for the same reason), and to the findings, which are saved with the task, in compact
 * form (`compactFindings`). The display order stays summary, findings, caveats, and no header
 * stands without a line under it. The Social line, the note and the tail are bounded by their
 * makers, so the summary always has about 290 characters or more.
 */
export function renderAnswer(
  title: string,
  answer: ResearchAnswer,
  review: Review,
  tail = "",
): string {
  const head = `Research: ${clean(title, 200, true)}`
  const uncertain =
    answer.uncertain.length > 0 ? ["", "Uncertain:", ...answer.uncertain.map((u) => `- ${u}`)] : []
  const note =
    review.verdict === "approve"
      ? "Checked by a reviewer run."
      : `Checked and corrected by a reviewer run (${review.problems.length} problem(s) fixed).`
  const social = answer.coverage && answer.coverage.length > 0 ? coverageLine(answer.coverage) : ""
  const after = [social, note, tail].filter((s) => s.length > 0).join("\n\n")
  const budget = MAX_MESSAGE_CHARS - after.length - 2
  const full =
    answer.findings.length > 0 ? ["", "Findings:", ...answer.findings.map(findingLine)] : []
  const whole = [head, "", answer.summary, ...full, ...uncertain]
  if (whole.join("\n").length <= budget) return `${whole.join("\n")}\n\n${after}`
  let room = budget - head.length - 2
  // A cut summary leaves room for the counts, so neither block vanishes without a word.
  const counts =
    (answer.uncertain.length > 0 ? CAVEATS_ALONE(answer.uncertain.length).length + 2 : 0) +
    (answer.findings.length > 0 ? FINDINGS_ALONE(answer.findings.length).length + 2 : 0)
  const summary = clean(answer.summary, room - counts)
  room -= summary.length
  const caveats = fitCaveats(answer.uncertain, room - 1)
  room -= caveats.length > 0 ? caveats.join("\n").length + 1 : 0
  const compact = compactFindings(answer.findings, room - 1)
  return `${fit([head, "", summary, ...compact, ...caveats], budget)}\n\n${after}`
}

/** Lines fitted into at most `max` characters, whole lines dropped from the end. */
export function fitLines(lines: string[], max: number): string {
  return fit(lines, max)
}

/**
 * The DM a reviewed second pass goes out as (0.9.0): what the gathered pages added to an answer
 * already sent, its new and corrected findings only, or one line when it adds nothing. At most
 * `MAX_MESSAGE_CHARS`; every piece was cleaned by `parseAnswer`, the title is cleaned here. When
 * the whole update does not fit (docket#132), the summary comes first, cut if it must while
 * leaving room for the count, and the findings follow in compact form under "New or corrected:",
 * as in `renderAnswer`.
 */
export function renderUpdate(title: string, update: ResearchAnswer, review: Review): string {
  const head = `Update to ${clean(title, 200, true)}:`
  if (update.findings.length === 0) {
    return `${head} the pages added nothing new, so the first answer stands.`
  }
  const note =
    review.verdict === "approve"
      ? "Checked by a reviewer run."
      : `Checked and corrected by a reviewer run (${review.problems.length} problem(s) fixed).`
  const budget = MAX_MESSAGE_CHARS - note.length - 2
  const header = "New or corrected:"
  const whole = [head, "", update.summary, "", header, ...update.findings.map(findingLine)]
  if (whole.join("\n").length <= budget) return `${whole.join("\n")}\n\n${note}`
  let room = budget - head.length - 2
  const summary = clean(update.summary, room - FINDINGS_ALONE(update.findings.length).length - 2)
  room -= summary.length
  const compact = compactFindings(update.findings, room - 1, header)
  return `${fit([head, "", summary, ...compact], budget)}\n\n${note}`
}
