/**
 * A research answer as data (plan 5.6): what the model returned is parsed field by field, capped,
 * and cleaned before any of it becomes message text or a finding. Nothing here trusts the shape
 * the JSON schema promised -- the CLI enforces it, but a stored draft comes back from the task's
 * state, and a reviewer could return a valid shape around hostile text. A page the agent read can
 * carry an instruction; the most it can do here is be quoted as text.
 */

import { clean, ZWSP } from "@rackbops/docket-core"

/** The cleaner lives in core, so the dispatcher's own messages use it too; re-exported here. */
export { clean, ZWSP }

/** One claim and the pages it rests on. */
export interface ResearchFinding {
  claim: string
  /** http(s) URLs the run says it opened. */
  sources: string[]
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
/** Discord's DM limit is 2000 characters; the rest is headroom for the host's own framing. */
export const MAX_MESSAGE_CHARS = 1900

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
            items: { type: "string", description: "A URL you opened." },
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
  // A URL is shown as is, so one that spells a mention could ping; it is no source.
  if (/@(everyone|here)\b|<[@#]/i.test(decodeURIComponentSafe(text))) return null
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
 * The answer in `value`, capped and cleaned, or null when it is not one. A claim with no usable
 * source is not a finding: it moves to `uncertain`, marked, since every claim a reader might act
 * on needs a source the run opened.
 */
export function parseAnswer(value: unknown): ResearchAnswer | null {
  if (!isObj(value) || typeof value.summary !== "string" || !Array.isArray(value.findings)) {
    return null
  }
  const summary = clean(value.summary, MAX_SUMMARY_CHARS)
  if (summary.length === 0) return null
  const findings: ResearchFinding[] = []
  const uncertain: string[] = []
  for (const f of value.findings) {
    if (!isObj(f) || typeof f.claim !== "string") continue
    const claim = clean(f.claim, MAX_CLAIM_CHARS, true)
    if (claim.length === 0) continue
    const raw = Array.isArray(f.sources) ? f.sources : []
    const sources = [...new Set(raw.map(safeUrl).filter((u): u is string => u !== null))]
    if (sources.length === 0) uncertain.push(`${claim} (no source given)`)
    else findings.push({ claim, sources: sources.slice(0, MAX_SOURCES_PER_FINDING) })
  }
  const said = Array.isArray(value.uncertain) ? value.uncertain : []
  for (const u of said) {
    if (typeof u !== "string") continue
    const line = clean(u, MAX_UNCERTAIN_CHARS, true)
    if (line.length > 0) uncertain.push(line)
  }
  const blocked = parseBlocked(value.blocked)
  return {
    summary,
    findings: findings.slice(0, MAX_FINDINGS),
    uncertain: uncertain.slice(0, MAX_UNCERTAIN),
    ...(blocked.length > 0 ? { blocked } : {}),
  }
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
      description: "The answer to send: the draft unchanged on approve, corrected on revise.",
    },
  },
  required: ["verdict", "problems"],
} as const

/** The reviewer's verdict in `value`, cleaned, or null when it is not one. */
export function parseReview(value: unknown): Review | null {
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
  const answer = parseAnswer(value.answer)
  // Approve or revise without a usable answer is not a verdict the type can act on.
  if (verdict !== "reject" && !answer) return null
  return { verdict, problems, answer: verdict === "reject" ? null : answer }
}

/** Fits `lines` into `max` characters, dropping whole lines from the end and saying so. */
function fit(lines: string[], max: number): string {
  const out: string[] = []
  let length = 0
  for (const [i, line] of lines.entries()) {
    const more = `(${lines.length - i} more lines not shown)`
    // Room for this line, and for the marker unless it is the last.
    const reserve = i < lines.length - 1 ? more.length + 1 : 0
    if (length + line.length + 1 + reserve > max) {
      out.push(more)
      break
    }
    out.push(line)
    length += line.length + 1
  }
  const text = out.join("\n")
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/** Lines as one DM of at most `MAX_MESSAGE_CHARS`, whole lines dropped from the end. */
export function fitMessage(lines: string[]): string {
  return fit(lines, MAX_MESSAGE_CHARS)
}

/**
 * The DM a reviewed answer goes out as, at most `MAX_MESSAGE_CHARS`. Every piece of it was
 * cleaned by `parseAnswer`; the title is the owner's own and is cleaned here. `tail`, when given,
 * goes after the reviewer's note and is kept whole: the caller bounds it (the "couldn't open" list
 * and the queued line, 0.9.0). Without it the DM is what it was before 0.9.0.
 */
export function renderAnswer(
  title: string,
  answer: ResearchAnswer,
  review: Review,
  tail = "",
): string {
  const lines = [`Research: ${clean(title, 200, true)}`, "", answer.summary]
  if (answer.findings.length > 0) {
    lines.push("", "Findings:")
    // Sources in <...> so Discord shows the link without an embed.
    for (const f of answer.findings) lines.push(`- ${f.claim} <${f.sources[0]}>`)
  }
  if (answer.uncertain.length > 0) {
    lines.push("", "Uncertain:")
    for (const u of answer.uncertain) lines.push(`- ${u}`)
  }
  const note =
    review.verdict === "approve"
      ? "Checked by a reviewer run."
      : `Checked and corrected by a reviewer run (${review.problems.length} problem(s) fixed).`
  const after = tail.length > 0 ? `${note}\n\n${tail}` : note
  return `${fit(lines, MAX_MESSAGE_CHARS - after.length - 2)}\n\n${after}`
}

/** Lines fitted into at most `max` characters, whole lines dropped from the end. */
export function fitLines(lines: string[], max: number): string {
  return fit(lines, max)
}

/**
 * The DM a reviewed second pass goes out as (0.9.0): what the gathered pages added to an answer
 * already sent, its new and corrected findings only, or one line when it adds nothing. At most
 * `MAX_MESSAGE_CHARS`; every piece was cleaned by `parseAnswer`, the title is cleaned here.
 */
export function renderUpdate(title: string, update: ResearchAnswer, review: Review): string {
  const head = `Update to ${clean(title, 200, true)}:`
  if (update.findings.length === 0) {
    return `${head} the pages added nothing new, so the first answer stands.`
  }
  const lines = [head, "", update.summary, "", "New or corrected:"]
  for (const f of update.findings) lines.push(`- ${f.claim} <${f.sources[0]}>`)
  const note =
    review.verdict === "approve"
      ? "Checked by a reviewer run."
      : `Checked and corrected by a reviewer run (${review.problems.length} problem(s) fixed).`
  return `${fit(lines, MAX_MESSAGE_CHARS - note.length - 2)}\n\n${note}`
}
