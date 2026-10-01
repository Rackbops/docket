/**
 * A research answer as data (plan 5.6): what the model returned is parsed field by field, capped,
 * and cleaned before any of it becomes message text or a finding. Nothing here trusts the shape
 * the JSON schema promised -- the CLI enforces it, but a stored draft comes back from the task's
 * state, and a reviewer could return a valid shape around hostile text. A page the agent read can
 * carry an instruction; the most it can do here is be quoted as text.
 */

/** One claim and the pages it rests on. */
export interface ResearchFinding {
  claim: string
  /** http(s) URLs the run says it opened. */
  sources: string[]
}

/** The shape both runs return (the reviewer inside its verdict). */
export interface ResearchAnswer {
  summary: string
  findings: ResearchFinding[]
  uncertain: string[]
}

export const MAX_SUMMARY_CHARS = 1200
export const MAX_CLAIM_CHARS = 400
export const MAX_URL_CHARS = 400
export const MAX_FINDINGS = 12
export const MAX_SOURCES_PER_FINDING = 4
export const MAX_UNCERTAIN = 6
export const MAX_UNCERTAIN_CHARS = 300
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
  },
  required: ["summary", "findings", "uncertain"],
} as const

/**
 * A zero-width space: after an `@` it stops a ping and leaves the text readable. Built from its
 * code so the source stays ASCII (the formatter would turn a `\u` escape into the character).
 */
export const ZWSP = String.fromCharCode(0x200b)

/** Drops control characters other than newline and tab. */
function withoutControls(text: string): string {
  let out = ""
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if ((code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f) continue
    out += ch
  }
  return out
}

/**
 * Makes text safe to put in a DM: no mention can ping (`@everyone`, `@here`, `<@id>`, `<@&id>`,
 * `<#id>`), no masked link can hide where it points, no control characters, one line per item
 * where the caller asks, and at most `max` characters.
 */
export function clean(text: string, max: number, oneLine = false): string {
  let out = withoutControls(text)
    // <@123>, <@!123>, <@&123>, <#123>, </cmd:123>: unwrap, so Discord renders plain text.
    .replace(/<(@[!&]?|#|\/)([^<>\s]{0,80})>/g, (_m, sigil: string, rest: string) => {
      return `${sigil === "/" ? "/" : sigil.replace(/[!&]/, "")}${ZWSP}${rest}`
    })
    // @everyone and @here: a zero-width space after the @ stops the ping.
    .replace(/@(everyone|here)/gi, `@${ZWSP}$1`)
    // [text](url): a masked link shows text and hides its target; break the pattern.
    .replace(/\]\(/g, "] (")
  if (oneLine) out = out.replace(/\s+/g, " ")
  out = out.trim()
  return out.length > max ? `${out.slice(0, max - 3).trimEnd()}...` : out
}

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
  return url.toString()
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
  return {
    summary,
    findings: findings.slice(0, MAX_FINDINGS),
    uncertain: uncertain.slice(0, MAX_UNCERTAIN),
  }
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
    const more = `(${lines.length - i} more lines not shown; the findings are saved in the tracker)`
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

/**
 * The DM a reviewed answer goes out as, at most `MAX_MESSAGE_CHARS`. Every piece of it was
 * cleaned by `parseAnswer`; the title is the owner's own and is cleaned here.
 */
export function renderAnswer(title: string, answer: ResearchAnswer, review: Review): string {
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
  return `${fit(lines, MAX_MESSAGE_CHARS - note.length - 2)}\n\n${note}`
}
