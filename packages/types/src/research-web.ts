import { DEFAULT_ALLOWED_TOOLS } from "@rackbops/docket-core"

/**
 * What a `web` first pass, and its reviewer, may use beyond the defaults (0.11.0, Rod's "add
 * firecrawl" after comparing a research answer with a run through the Firecrawl tools): the
 * Firecrawl MCP server's search and scrape. Only the web first pass gets them: a run on gathered
 * pages (a `sent` request or a second pass) keeps `DEFAULT_ALLOWED_TOOLS` and its denials as in
 * 0.10.0. The runner (Rackbops/docket-runner) holds the ceiling of tools a Job may name: these
 * Jobs need runner 0.0.6 or later, whose ceiling admits the two names and which drops them when
 * it has no Firecrawl key (the run then falls back to WebFetch). A runner older than that fails
 * these Jobs (0.0.5 throws `ToolCeilingError`), so the runner is released first.
 *
 * The permission rules cannot see a tool's parameters, so nothing in the tool lists stops a
 * scrape with a disguising proxy or of an eBay URL: `WEB_DISALLOWED_TOOLS` denies eBay to WebFetch
 * only. The prompt is the control there (`firecrawlLines`, `firecrawlChecks`): `proxy: "basic"`
 * always, one page at a time, and no eBay URL through any tool. The reviewer's eBay handling and
 * the belt (`withBarredSites`) read the answer's addresses, so they apply whichever tool fetched
 * the page.
 */
export const FIRECRAWL_TOOLS = [
  "mcp__firecrawl__firecrawl_search",
  "mcp__firecrawl__firecrawl_scrape",
] as const

/** A `web` first pass's allowed tools (0.11.0): WebSearch, WebFetch, then `FIRECRAWL_TOOLS`. */
export const WEB_ALLOWED_TOOLS: readonly string[] = [...DEFAULT_ALLOWED_TOOLS, ...FIRECRAWL_TOOLS]

/** The research run's rules for the Firecrawl tools (0.11.0); a web first pass only. */
export function firecrawlLines(): string[] {
  return [
    "Read pages with WebFetch first. When a page refuses WebFetch (a 403, a block, a CAPTCHA " +
      "or challenge page), read it with `firecrawl_scrape` instead. Always pass " +
      '`proxy: "basic"` to it; never "stealth", "enhanced" or "auto", and nothing else that ' +
      "disguises the request. Scrape one page at a time: never several pages of the same site " +
      "in parallel. Never pass any eBay URL to any tool, Firecrawl included. You may use " +
      "`firecrawl_search` as you would web search. If Firecrawl is refused too, the page did " +
      "not open: handle it as a page that refused you, as above.",
  ]
}

/** The reviewer's rules for the Firecrawl tools (0.11.0); a web first pass only. */
export function firecrawlChecks(): string[] {
  return [
    "- To open a source, use WebFetch first; when a page refuses it (a 403, a block, a CAPTCHA), " +
      'read it with `firecrawl_scrape`, always with `proxy: "basic"` (never "stealth", ' +
      '"enhanced" or "auto", nothing that disguises the request), one page at a time, never ' +
      "several pages of one site in parallel. Never pass any eBay URL to any tool. You may use " +
      "`firecrawl_search` as you would web search.",
  ]
}

/**
 * BoardGameGeek's category rankings (0.11.0): the eight its own subdomains define, each a
 * `familyids[0]` value on its advanced search. The ids were observed on boardgamegeek.com on
 * 2026-10-18, not documented by BGG: a run that finds one wrong falls back to the category's
 * own ranking page.
 */
export const BGG_CATEGORIES: readonly { name: string; familyId: number }[] = [
  { name: "Strategy", familyId: 5497 },
  { name: "Family", familyId: 5499 },
  { name: "Thematic", familyId: 5496 },
  { name: "Party", familyId: 5498 },
  { name: "Abstract", familyId: 4666 },
  { name: "Customizable", familyId: 4667 },
  { name: "Children's", familyId: 4665 },
  { name: "Wargames", familyId: 4664 },
]

/**
 * A BGG advanced search for one category's games of one year, best rated first, with at least
 * 30 ratings and no expansions: the shape observed on 2026-10-18.
 */
export function bggCategoryUrl(familyId: number, year: number): string {
  return (
    "https://boardgamegeek.com/search/boardgame?sort=bggrating&advsearch=1" +
    `&range[yearpublished][min]=${year}&range[yearpublished][max]=${year}` +
    `&range[numvoters][min]=30&nosubtypes[0]=boardgameexpansion&familyids[0]=${familyId}`
  )
}

/** "Strategy", "Family", ... as one list in words. */
function categoryNames(): string {
  const names = BGG_CATEGORIES.map((c) => c.name)
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

/**
 * The site's own categories (0.11.0, Rod's comparison with a run that used BGG's): where the
 * question asks about categories and the best source defines its own, the answer uses that
 * taxonomy and says so, rather than inventing genres or saying no source defines them. A category
 * with no qualifying entry is answered "none yet", with why, never skipped. Every research run.
 * A first pass's summary names every category's pick in one compact run (`COMPACT_RUN`;
 * a second pass, `second`, names only the categories whose pick changed): `renderAnswer` fits the DM into
 * `MAX_MESSAGE_CHARS` by dropping whole lines from the end, so a category answered only in a late
 * finding can fall out of the DM; the summary comes first and is kept.
 */
export function categoryLines(second = false): string[] {
  return [
    'When the question asks about categories (or "each of the major" kinds of something) and ' +
      "the best source defines its own categories, use that site's categories and say so" +
      (second ? "" : " in the summary") +
      "; do not invent genres, and do not say that no source defines them. For " +
      `board games these are BoardGameGeek's ${BGG_CATEGORIES.length} category rankings: ` +
      `${categoryNames()}. A category with no entry that qualifies is answered "none yet", ` +
      "with the reason; never leave it out." +
      (second
        ? // A second pass's summary says what changed (research.ts), so no compact run here.
          " In this update, the summary names any category whose pick changed."
        : ` ${COMPACT_RUN}`),
  ]
}

/**
 * The compact-run sentence (0.11.0): a first pass only. A second pass's summary says what
 * changed and repeats nothing, so it names only the categories whose pick changed.
 */
export const COMPACT_RUN =
  "The summary itself names every category's pick in one compact run, such as \"Strategy: X; " +
  "Family: Y; ...; Children's: none yet (no 2026 game has 30 ratings)\", so none is lost when " +
  "a long answer is cut; the findings carry each pick's source."

/** The BGG search hint a web first pass may use (0.11.0), with the observed ids. */
export function bggSearchHint(): string[] {
  const ids = BGG_CATEGORIES.map((c) => `${c.name} ${c.familyId}`).join(", ")
  return [
    "A hint you may use: a BoardGameGeek advanced search shows one category for one year, such " +
      `as ${bggCategoryUrl(5497, 2026)} (Strategy, 2026). ` +
      `Change the year and the \`familyids[0]\` value for the category: ${ids}. These ids were ` +
      "seen on the site, not documented by it: if one shows the wrong category, use that " +
      "category's own ranking page.",
  ]
}

/**
 * The reviewer's check of the site's own categories (0.11.0): an answer that invents categories
 * where the best source defines them, or skips one with no qualifying entry, is revised.
 */
export function categoryChecks(): string[] {
  return [
    "- Where the question asks about categories and the best source defines its own (for " +
      `board games, BoardGameGeek's ${BGG_CATEGORIES.length}: ${categoryNames()}), the answer ` +
      "uses them and says so. An answer that invents its own categories, or says no source " +
      "defines them, while the source does, is `revise`d onto the source's categories. A " +
      'category with no qualifying entry is answered "none yet" with the reason, never left ' +
      "out: `revise` an answer that skips one. The summary names every category's pick in " +
      'one compact run ("Strategy: X; Family: Y; ..."), since the findings may be cut from ' +
      "the DM: `revise` a summary that leaves a category to the findings alone.",
  ]
}
