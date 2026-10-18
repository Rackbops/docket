import { DEFAULT_ALLOWED_TOOLS, DEFAULT_DISALLOWED_TOOLS } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"

import {
  BGG_CATEGORIES,
  bggCategoryUrl,
  FIRECRAWL_TOOLS,
  type GatheredPage,
  type ResearchConfig,
  researchJob,
  reviewJob,
  SENT_DISALLOWED_TOOLS,
  WEB_ALLOWED_TOOLS,
  WEB_DISALLOWED_TOOLS,
} from "../src/index.js"

// Rod's question, the one the comparison came from (0.11.0).
const WEB: ResearchConfig = {
  question: "what is the best boardgame released in 2026, in each of the major categories",
}
const SENT: ResearchConfig = { ...WEB, sources: "sent" }
const BGG = "https://boardgamegeek.com/browse/boardgame?sort=rank&year=2026"
const PAGES: GatheredPage[] = [
  { url: BGG, title: "Board game rank, 2026", text: "1. Example Game (2026), rated 8.4." },
]
const DRAFT = {
  summary: "Example Game is the best-reviewed 2026 strategy game.",
  findings: [{ claim: "Example Game won a 2026 award.", sources: ["https://example.org/a"] }],
  uncertain: [],
}
const SCRAPE = "mcp__firecrawl__firecrawl_scrape"
const SEARCH = "mcp__firecrawl__firecrawl_search"

/** Every run on gathered pages: a `sent` request's two runs and a second pass's two. */
function gatheredRuns() {
  return [
    researchJob(SENT, PAGES),
    researchJob(WEB, PAGES, DRAFT),
    reviewJob(SENT, DRAFT, PAGES),
    reviewJob(WEB, DRAFT, PAGES, DRAFT),
  ]
}

describe("Firecrawl tools by pass (0.11.0)", () => {
  it("names exactly the two Firecrawl tools, after WebSearch and WebFetch", () => {
    expect(FIRECRAWL_TOOLS).toEqual([SEARCH, SCRAPE])
    expect(WEB_ALLOWED_TOOLS).toEqual(["WebSearch", "WebFetch", SEARCH, SCRAPE])
    // The core's default list, which the runner mirrors, is unchanged.
    expect(DEFAULT_ALLOWED_TOOLS).toEqual(["WebSearch", "WebFetch"])
  })

  it("a web first pass and its reviewer get them, with the eBay denials as in 0.10.0", () => {
    for (const spec of [
      researchJob(WEB),
      researchJob(WEB, undefined, undefined, { canWait: true }),
      reviewJob(WEB, DRAFT),
      reviewJob(WEB, DRAFT, undefined, undefined, { canWait: true }),
    ]) {
      expect(spec.allowedTools).toEqual([...WEB_ALLOWED_TOOLS])
      expect(spec.disallowedTools).toEqual([...DEFAULT_DISALLOWED_TOOLS, ...WEB_DISALLOWED_TOOLS])
    }
  })

  it("a sent request and a second pass keep the defaults and their bans unchanged", () => {
    for (const spec of gatheredRuns()) {
      expect(spec.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS])
      expect(spec.disallowedTools).toEqual([...DEFAULT_DISALLOWED_TOOLS, ...SENT_DISALLOWED_TOOLS])
      expect(spec.allowedTools?.some((t) => t.includes("firecrawl"))).toBe(false)
      expect(spec.prompt).not.toContain("firecrawl")
    }
  })
})

describe("the Firecrawl rules in the prompts (0.11.0)", () => {
  const rules = (prompt: string) => {
    expect(prompt).toContain("WebFetch first")
    expect(prompt).toContain("`firecrawl_scrape`")
    expect(prompt).toContain('`proxy: "basic"`')
    expect(prompt).toContain('never "stealth", "enhanced" or "auto"')
    expect(prompt).toContain("disguises the request")
    expect(prompt).toContain("one page at a time")
    expect(prompt).toContain("in parallel")
    expect(prompt).toContain("Never pass any eBay URL to any tool")
    expect(prompt).toContain("`firecrawl_search` as you would web search")
  }

  it("the research run: WebFetch first, scrape on a refusal, basic proxy, never eBay", () => {
    const prompt = researchJob(WEB).prompt
    rules(prompt)
    expect(prompt).toContain("Scrape one page at a time")
    expect(prompt).toContain(
      "If Firecrawl is refused too, the page did not open: handle it as a page that refused you",
    )
    expect(prompt).toContain(
      "a page that refuses WebFetch gets one more try through `firecrawl_scrape`, as below",
    )
    expect(prompt.indexOf("decide first which source")).toBeLessThan(
      prompt.indexOf("WebFetch first"),
    )
  })

  it("the reviewer: the same rules, and eBay claims moved whichever tool fetched them", () => {
    const prompt = reviewJob(WEB, DRAFT).prompt
    rules(prompt)
    expect(prompt).toContain("through any tool (WebFetch, Firecrawl or another)")
    expect(prompt).toContain("whichever tool listed or fetched it")
  })
})

describe("the site's own categories (0.11.0)", () => {
  it("BGG's eight category rankings, with the ids observed on 2026-10-18", () => {
    expect(BGG_CATEGORIES.map((c) => [c.name, c.familyId])).toEqual([
      ["Strategy", 5497],
      ["Family", 5499],
      ["Thematic", 5496],
      ["Party", 5498],
      ["Abstract", 4666],
      ["Customizable", 4667],
      ["Children's", 4665],
      ["Wargames", 4664],
    ])
    expect(bggCategoryUrl(5497, 2026)).toBe(
      "https://boardgamegeek.com/search/boardgame?sort=bggrating&advsearch=1" +
        "&range[yearpublished][min]=2026&range[yearpublished][max]=2026" +
        "&range[numvoters][min]=30&nosubtypes[0]=boardgameexpansion&familyids[0]=5497",
    )
  })

  it("every research run uses the site's taxonomy and answers an empty one 'none yet'", () => {
    for (const prompt of [researchJob(WEB).prompt, researchJob(SENT, PAGES).prompt]) {
      expect(prompt).toContain("use that site's categories and say so")
      expect(prompt).toContain("do not invent genres")
      expect(prompt).toContain("do not say that no source defines them")
      expect(prompt).toContain(
        "BoardGameGeek's 8 category rankings: Strategy, Family, Thematic, Party, Abstract, " +
          "Customizable, Children's and Wargames",
      )
      expect(prompt).toContain('is answered "none yet", with the reason; never leave it out')
    }
  })

  it("a web first pass gets the BGG advanced-search hint; gathered pages do not", () => {
    const prompt = researchJob(WEB).prompt
    expect(prompt).toContain("A hint you may use")
    expect(prompt).toContain(bggCategoryUrl(5497, 2026))
    expect(prompt).toContain("Strategy 5497, Family 5499, Thematic 5496")
    expect(prompt).toContain("Wargames 4664")
    expect(prompt).toContain("not documented by it")
    for (const spec of gatheredRuns().slice(0, 2)) {
      expect(spec.prompt).not.toContain("A hint you may use")
    }
  })

  it("the reviewer revises an answer that invents categories where the source defines them", () => {
    for (const prompt of [reviewJob(WEB, DRAFT).prompt, reviewJob(SENT, DRAFT, PAGES).prompt]) {
      expect(prompt).toContain("the best source defines its own")
      expect(prompt).toContain(
        "An answer that invents its own categories, or says no source defines them, while the " +
          "source does, is `revise`d onto the source's categories",
      )
      expect(prompt).toContain('answered "none yet" with the reason')
    }
  })
})
