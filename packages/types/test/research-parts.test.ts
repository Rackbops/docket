import { describe, expect, it } from "vitest"

import {
  ANSWER_SCHEMA,
  type GatheredPage,
  MAX_MESSAGE_CHARS,
  parseAnswer,
  parseReview,
  type ResearchConfig,
  renderAnswer,
  researchJob,
  researchState,
  reviewJob,
} from "../src/index.js"

// Rod's question, the one the feedback came from (0.10.0).
const ROD: ResearchConfig = {
  question: "what is the best boardgame released in 2026, in each of the major categories",
}

const CATEGORIES = ["strategy", "family", "party", "cooperative", "thematic", "wargame"]

/** An answer that names the categories, then the best in each: what the run should return. */
const COVERED = {
  summary:
    "The major categories are strategy, family, party, cooperative, thematic and wargame. " +
    "The best-reviewed 2026 release in each is listed below.",
  findings: [
    {
      claim: `The major board game categories are ${CATEGORIES.join(", ")}.`,
      sources: ["https://example.org/categories"],
    },
    ...CATEGORIES.map((c) => ({
      claim: `Example ${c} game is the best-reviewed ${c} game released in 2026.`,
      sources: [`https://example.org/${c}`],
    })),
  ],
  uncertain: ["Wargame: only one 2026 review could be found."],
}

const PAGES: GatheredPage[] = [
  { url: "https://example.org/rank", title: "Rank", text: "1. Example Game (2026)." },
]

/** The lines of `prompt` that are reviewer checks, in order. */
function checks(prompt: string): string[] {
  return prompt.split("\n").filter((l) => l.startsWith("- "))
}

describe("the research run splits the question into parts (0.10.0)", () => {
  it("asks for the parts before any search, dependent parts in order", () => {
    const prompt = researchJob(ROD).prompt
    expect(prompt).toContain(
      "Before you search, split the question into the parts it needs answered",
    )
    expect(prompt).toContain("including any list the question takes for granted")
    expect(prompt).toContain(
      "first establish what the major categories are, then find the best in each",
    )
    expect(prompt).toContain("Settle the parts in that order, and answer every one")
    // The split comes before the instruction to search.
    expect(prompt.indexOf("Before you search")).toBeLessThan(prompt.indexOf("Use web search"))
  })

  it("puts a part it could not settle in `uncertain`, never leaves one out", () => {
    const prompt = researchJob(ROD).prompt
    expect(prompt).toContain("A part you could not settle goes in `uncertain`, naming the part")
    expect(prompt).toContain("never leave a part out silently")
  })

  it("asks the same of a request on gathered pages", () => {
    expect(researchJob({ ...ROD, sources: "sent" }, PAGES).prompt).toContain(
      "Before you search, split the question into the parts",
    )
  })

  it("on a second pass, fills a part the earlier answer left unsettled", () => {
    const second = researchJob(ROD, PAGES, COVERED).prompt
    expect(second).toContain("split the question into the parts")
    expect(second).toContain(
      "A part the earlier answer left unsettled (in its `uncertain`, or not at all) that the " +
        "pages settle is a new finding.",
    )
    expect(researchJob(ROD).prompt).not.toContain("earlier answer left unsettled")
  })

  it("leaves the answer schema as it was: the split is prompt-only", () => {
    expect(Object.keys(ANSWER_SCHEMA.properties)).toEqual([
      "summary",
      "findings",
      "uncertain",
      "blocked",
    ])
    expect(ANSWER_SCHEMA.required).toEqual(["summary", "findings", "uncertain"])
  })
})

describe("the reviewer checks every part is answered (0.10.0)", () => {
  it("works out the parts first, presupposed lists included", () => {
    const prompt = reviewJob(ROD, COVERED).prompt
    const first = checks(prompt)[0]
    expect(first).toContain("First work out the parts the question implies")
    expect(first).toContain("including any list it takes for granted")
    expect(first).toContain("means naming the major categories, then answering for each one")
    // The spike's checks follow it, unchanged.
    expect(checks(prompt)[1]).toContain("Open the sources behind every claim")
  })

  it("never approves an answer that silently skips a part", () => {
    const prompt = reviewJob(ROD, COVERED).prompt
    expect(prompt).toContain("An answer that silently skips a part is never approved")
    expect(prompt).toContain("`revise` it, filling the part from the sources")
    expect(prompt).toContain("or `reject` it")
    expect(prompt).toContain("`approve` if the draft stands as is and covers every part")
  })

  it("does the same on a request on gathered pages", () => {
    const prompt = reviewJob({ ...ROD, sources: "sent" }, COVERED, PAGES).prompt
    expect(prompt).toContain("An answer that silently skips a part is never approved")
  })

  it("on a second pass, never approves an update that skips a part the pages settle", () => {
    const prompt = reviewJob(ROD, COVERED, PAGES, COVERED).prompt
    expect(prompt).toContain("Work out the parts the question implies, as for a full answer")
    expect(prompt).toContain(
      "Where the earlier answer left a part unsettled (in its `uncertain`, or not at all) and " +
        "the pages settle it, the update fills it.",
    )
    expect(prompt).toContain("An update that silently skips such a part is never approved")
    expect(prompt).toContain("`revise` it, filling the part from the pages, or `reject` it")
    // The full answer's check is not asked of an update, which holds only what changed.
    expect(prompt).not.toContain("An answer that silently skips a part")
  })
})

describe("0.9.0 answers and states read as before", () => {
  it("parses a draft as it did, and a stray `parts` field is dropped, not trusted", () => {
    const withParts = {
      ...COVERED,
      parts: [{ part: "Major categories", answer: "@everyone strategy, family" }],
    }
    const parsed = parseAnswer(withParts)
    expect(parsed).toEqual(parseAnswer(COVERED))
    expect(parsed).not.toHaveProperty("parts")
    const review = parseReview({ verdict: "revise", problems: ["x"], answer: withParts })
    expect(review?.answer).not.toHaveProperty("parts")
  })

  it("reads a stored 0.9.0 awaiting-pages state unchanged", () => {
    const waiting = {
      phase: "awaiting-pages",
      failures: 0,
      draft: COVERED,
      pass: 1,
      blocked: [{ site: "boardgamegeek.com", why: "403" }],
      earlier: COVERED,
    }
    expect(researchState(waiting)).toEqual(waiting)
  })

  it("an answer covering every part still fits one DM", () => {
    const answer = parseAnswer(COVERED)
    if (!answer) throw new Error("the answer did not parse")
    const dm = renderAnswer(ROD.question, answer, { verdict: "approve", problems: [], answer })
    expect(dm.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    for (const c of CATEGORIES) expect(dm).toContain(`Example ${c} game`)
  })
})
