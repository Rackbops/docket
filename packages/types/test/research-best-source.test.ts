import {
  createTask,
  type Executor,
  type JobResult,
  type JobSpec,
  Lanes,
  MemoryStore,
} from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"

import {
  ANSWER_SCHEMA,
  BARRED_SITES,
  blockedKey,
  type GatheredPage,
  MAX_BLOCKED,
  MAX_MESSAGE_CHARS,
  NOT_OPENED_WHY,
  type ReadSources,
  type ResearchConfig,
  researchJob,
  researchState,
  researchType,
  reviewJob,
  SENT_DISALLOWED_TOOLS,
  SOURCES_WAIT_MS,
  TASK_TYPES,
  uniqueBlocked,
  WEB_DISALLOWED_TOOLS,
  withBarredSites,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, T0 } from "./helpers.js"

const WEB: ResearchConfig = {
  question: "what is the best boardgame released in 2026, in each of the major categories",
}
const SENT: ResearchConfig = { ...WEB, sources: "sent" }
const BGG = "https://boardgamegeek.com/browse/boardgame?sort=rank&year=2026"
const EBAY_ITEM = "https://www.ebay.com/itm/123"

/** t8's answer, in the shape that drew Rod's feedback: secondary sources, BGG not checked. */
const T8 = {
  summary: "Example Game is the best-reviewed 2026 strategy game.",
  findings: [
    { claim: "Example Game won a 2026 design award.", sources: ["https://example.org/award"] },
  ],
  uncertain: ["I didn't check BoardGameGeek, so I have no rating-based ranking."],
}
/** An answer that names no barred site. */
const PLAIN = {
  summary: "Example Game is the best-reviewed 2026 strategy game.",
  findings: T8.findings,
  uncertain: [],
}
const BLOCKED = [{ site: "boardgamegeek.com", url: BGG, why: "403 Forbidden" }]
const UPDATE = {
  summary: "The BGG ranking puts Example Game first.",
  findings: [{ claim: "Example Game is rated 8.4 on BoardGameGeek.", sources: [BGG] }],
  uncertain: [],
}
const PAGES: GatheredPage[] = [
  { url: BGG, title: "Board game rank, 2026", text: "1. Example Game (2026), rated 8.4." },
]
const BGG_SITE = BARRED_SITES[0]

function ok(structuredOutput: unknown, totalCostUsd = 0.3): JobResult {
  return { kind: "success", result: "done", structuredOutput, totalCostUsd, durationMs: 1000 }
}
const approve = (answer: unknown) => ok({ verdict: "approve", problems: [], answer }, 0.1)
const revise = (answer: unknown) =>
  ok({ verdict: "revise", problems: ["the best source is missing"], answer }, 0.1)

function scripted(...answers: JobResult[]) {
  const specs: JobSpec[] = []
  const executor: Executor = {
    run: async (spec) => {
      specs.push(spec)
      const next = answers.shift()
      if (!next) throw new Error("the test ran out of recorded results")
      return next
    },
  }
  return { executor, specs }
}

/** A request made, then `ticks` execute ticks, `advance` ms apart (0: all at once). */
async function run(
  answers: JobResult[],
  readSources?: ReadSources,
  config: ResearchConfig = WEB,
  ticks = 2,
  advance = 0,
) {
  const { executor, specs } = scripted(...answers)
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const type = researchType(readSources ? { readSources } : {})
  const larry = await store.createUser({ discordId: "d-larry", at: T0 })
  const types = { ...TASK_TYPES, research: type }
  const lanes = new Lanes({ store, clock, types, notifier, executor })
  const { task } = await createTask(
    store,
    actor(larry),
    larry,
    { type, title: "Best of 2026", config, schedule: { kind: "once", at: T0 } },
    clock.now(),
  )
  for (let i = 0; i < ticks; i++) {
    if (i >= 2 && advance > 0) clock.advance(advance)
    await lanes.tickExecute()
  }
  const after = await store.getTask(task.id)
  const texts = notifier.sent.map((m) => m.message.text)
  return { text: texts[0] ?? "", texts, after, specs }
}

const noPages: ReadSources = async () => []

describe("the prompts the runs get, by whether a fuller pass can follow (0.10.0)", () => {
  it("a web first pass with a store: the best source goes in `blocked`, a real URL only", async () => {
    const r = await run([ok(PLAIN), approve(PLAIN)], noPages)
    const [research, review] = r.specs.map((s) => s.prompt)
    expect(research).toContain("decide first which source is the best one for it")
    expect(research).toContain("for board games, BoardGameGeek; for listings and sold prices, eBay")
    expect(research).toContain("Open BoardGameGeek like any other site: an ordinary read")
    expect(research).toContain("eBay is not opened from this run: do not try it.")
    expect(research).toContain(
      "a 403, a CAPTCHA or challenge page, an empty or blocked body, a sign-in wall",
    )
    expect(research).toContain(
      "list it in `blocked` with its site, its URL only when that is the page's real address " +
        "(such as BoardGameGeek's ranking or browse page), never a guessed one",
    )
    expect(research).toContain(
      'Never write in `summary` or `uncertain` that you "didn\'t check" it',
    )
    expect(research).not.toContain("one short `uncertain` line")
    expect(research).not.toContain("Name it in `uncertain` too")
    expect(research?.indexOf("best one for it")).toBeLessThan(
      research?.indexOf("Use web search") ?? 0,
    )
    expect(review).toContain("Name the best source for each part")
    expect(review).toContain(
      "neither among its findings' sources nor in `blocked`, the verdict is `revise`: add it to " +
        "`blocked` (its site, its URL only when that is the page's real address",
    )
    expect(review).toContain("never a guessed one")
    expect(review).toContain('("I didn\'t check BoardGameGeek") is no answer: move it to `blocked`')
    expect(review).toContain("You may open BoardGameGeek like any site.")
    expect(review).toContain(
      "a claim resting only on an eBay address, whichever tool listed or fetched it, is not one " +
        "an answer may rest on, so move it to `uncertain`",
    )
  })

  it("a web request with no store: the missing source in one short uncertain line", async () => {
    const r = await run([ok(PLAIN), approve(PLAIN)])
    const [research, review] = r.specs.map((s) => s.prompt)
    expect(research).toContain("Open BoardGameGeek like any other site")
    expect(research).toContain(
      'name the missing source in one short `uncertain` line, such as "BoardGameGeek refused ' +
        'the request, so its ranking is not used"',
    )
    expect(research).not.toContain("Never write in `summary` or `uncertain`")
    expect(research).not.toContain("its URL only when")
    expect(review).toContain(
      "neither among its findings' sources nor named in `uncertain`, the verdict is `revise`: " +
        "add one short `uncertain` line naming it",
    )
    expect(review).not.toContain("move it to `blocked`")
    expect(review).toContain("move it to `uncertain`")
  })

  it("a request on gathered pages: neither site opened, no best-source review", async () => {
    const r = await run([ok(PLAIN), approve(PLAIN)], async () => PAGES, SENT)
    const [research, review] = r.specs.map((s) => s.prompt)
    expect(research).toContain("BoardGameGeek and eBay are not opened from this run: do not try.")
    expect(research).toContain("one of them and no gathered page is from it")
    expect(research).toContain(
      'one short `uncertain` line, such as "BoardGameGeek was not among the pages read"',
    )
    expect(research).not.toContain("Never write in `summary` or `uncertain`")
    expect(research).not.toContain("Open BoardGameGeek like any other site")
    expect(research).toContain("Name it in `uncertain` too: `blocked` is not shown.")
    expect(review).not.toContain("Name the best source")
    expect(review).not.toContain("move it to `blocked`")
  })

  it("a second pass: neither site opened, the uncertain line, no best-source review", async () => {
    const r = await run(
      [ok({ ...PLAIN, blocked: BLOCKED }), approve(PLAIN), ok(UPDATE), approve(UPDATE)],
      async () => PAGES,
      WEB,
      4,
      SOURCES_WAIT_MS,
    )
    expect(r.specs).toHaveLength(4)
    const [, , research, review] = r.specs.map((s) => s.prompt)
    expect(research).toContain("<<<EARLIER")
    expect(research).toContain("BoardGameGeek and eBay are not opened from this run: do not try.")
    expect(research).toContain('"BoardGameGeek was not among the pages read"')
    expect(research).toContain("Name it in `uncertain` too: `blocked` is not shown.")
    expect(research).not.toContain("Never write in `summary` or `uncertain`")
    expect(review).not.toContain("Name the best source")
    expect(r.texts[1]).toContain("Update to")
  })

  it("canWait is ignored on gathered pages and on a second pass", () => {
    const opts = { canWait: true }
    expect(researchJob(SENT, PAGES, undefined, opts).prompt).not.toContain("never a guessed one")
    expect(researchJob(WEB, PAGES, PLAIN, opts).prompt).not.toContain("never a guessed one")
    expect(reviewJob(SENT, PLAIN, PAGES, undefined, opts).prompt).not.toContain(
      "Name the best source",
    )
    expect(reviewJob(WEB, PLAIN, PAGES, PLAIN, opts).prompt).not.toContain("Name the best source")
  })

  it("the schema's `blocked` covers a best source the run could not or may not open", () => {
    expect(ANSWER_SCHEMA.properties.blocked.description).toContain(
      "the best source for a part that you could not or may not open",
    )
  })
})

describe("tool denials", () => {
  it("a web first pass and its reviewer may fetch BoardGameGeek, never eBay", () => {
    const bgg = (tools: string[]) => tools.some((t) => /boardgamegeek|geekdo/.test(t))
    expect(bgg(researchJob(WEB).disallowedTools ?? [])).toBe(false)
    expect(bgg(reviewJob(WEB, T8).disallowedTools ?? [])).toBe(false)
    expect(WEB_DISALLOWED_TOOLS).toEqual(
      ["ebay.*", "*.ebay.*", "ebay.co.*", "*.ebay.co.*", "ebay.com.*", "*.ebay.com.*"].map(
        (h) => `WebFetch(domain:${h})`,
      ),
    )
    expect(researchJob(WEB).disallowedTools).toEqual(expect.arrayContaining(WEB_DISALLOWED_TOOLS))
    expect(reviewJob(WEB, T8).disallowedTools).toEqual(expect.arrayContaining(WEB_DISALLOWED_TOOLS))
  })

  it("runs on gathered pages keep both denied, the list as in 0.9.0", () => {
    for (const tools of [
      researchJob(SENT, PAGES).disallowedTools,
      researchJob(WEB, PAGES, PLAIN).disallowedTools,
      reviewJob(SENT, T8, PAGES).disallowedTools,
      reviewJob(WEB, T8, PAGES, PLAIN).disallowedTools,
    ]) {
      expect(tools).toEqual(expect.arrayContaining(SENT_DISALLOWED_TOOLS))
    }
    expect(SENT_DISALLOWED_TOOLS).toEqual(
      [
        "boardgamegeek.com",
        "*.boardgamegeek.com",
        "geekdo.com",
        "*.geekdo.com",
        "ebay.*",
        "*.ebay.*",
        "ebay.co.*",
        "*.ebay.co.*",
        "ebay.com.*",
        "*.ebay.com.*",
      ].map((h) => `WebFetch(domain:${h})`),
    )
    expect(BARRED_SITES.map((b) => b.site)).toEqual(["boardgamegeek.com", "ebay.com"])
  })
})

describe("withBarredSites, the belt", () => {
  const bgg = { site: "boardgamegeek.com", why: NOT_OPENED_WHY }
  const ebay = { site: "ebay.com", why: NOT_OPENED_WHY }
  const withSummary = (summary: string) => ({ ...PLAIN, summary })

  it("adds BoardGameGeek where a summary or uncertain sentence names it as not read", () => {
    expect(withBarredSites(T8, [])).toEqual([bgg])
    for (const summary of [
      "BGG refused the request (403), so the ranking is from reviews.",
      "Example Game leads. BoardGameGeek could not be opened.",
      "The BoardGameGeek ranking was not checked.",
      // A curly apostrophe reads as a straight one.
      "I didn’t check BoardGameGeek.",
      "BoardGameGeek hasn't been read.",
      "BoardGameGeek haven't loaded for me.",
      "BGG hadn't been opened.",
      "The BGG page isn't available.",
      "BGG wasn't reachable.",
      "BoardGameGeek has not been opened.",
      "Ranked from reviews without checking BoardGameGeek.",
      "Ranked without opening BGG.",
      "There are no BGG ratings here.",
      "No BoardGameGeek rankings were used.",
      "No BoardGameGeek data.",
      // "e.g." is no stop: the sentence still names BGG with its marker.
      "Reference sites, e.g. BoardGameGeek, were not checked.",
      "Reference sites (i.e. BGG) could not be opened.",
      "I could not verify the BGG rating.",
      "I couldn't retrieve the BoardGameGeek ranking.",
      "BoardGameGeek failed to load.",
      "The BGG page timed out.",
      "BGG access was denied.",
      "BoardGameGeek wouldn't load.",
      "BGG: not checked.",
    ]) {
      expect(withBarredSites(withSummary(summary), []), summary).toEqual([bgg])
    }
  })

  it("leaves a passing mention of BoardGameGeek alone, and a marker in another sentence", () => {
    for (const summary of [
      "Ranked by BGG users, Example Game leads.",
      "Ranked by BGG users. The publisher's page was blocked.",
      "BoardGameGeek ranks it first; the publisher's store was unavailable.",
      "BoardGameGeek has no data errors here.",
      "No board game is better; BGG agrees.",
      "I didn't use the BGG weight in the ranking.",
      "I didn't see anything on BGG suggesting a reprint.",
    ]) {
      expect(withBarredSites(withSummary(summary), []), summary).toEqual([])
    }
    // A claim is not where the run says what it could not read.
    const claim = {
      ...PLAIN,
      findings: [
        { claim: "BoardGameGeek did not list it before May.", sources: ["https://example.org"] },
      ],
    }
    expect(withBarredSites(claim, [])).toEqual([])
  })

  it("leaves BoardGameGeek alone when the outgoing answer cites one of its pages", () => {
    const cited = {
      ...T8,
      findings: [...T8.findings, { claim: "BoardGameGeek rates it 8.4.", sources: [BGG] }],
    }
    expect(withBarredSites(cited, [])).toEqual([])
    // geekdo-images.com is not geekdo.com: that is no BGG page opened.
    const images = {
      ...T8,
      findings: [{ claim: "Its cover art.", sources: ["https://cf.geekdo-images.com/x.jpg"] }],
    }
    expect(withBarredSites(images, [])).toEqual([bgg])
  })

  it("reads the draft's summary and uncertain lines too, so a rewording cannot hide it", () => {
    const reworded = { ...PLAIN, uncertain: ["No rating-based ranking was available."] }
    expect(withBarredSites(reworded, [])).toEqual([])
    expect(withBarredSites(reworded, [], T8)).toEqual([bgg])
  })

  it("reads the draft's findings too, so moving an eBay-only claim to uncertain keeps it", () => {
    const draft = {
      ...PLAIN,
      findings: [
        { claim: "Sold prices are near $40.", sources: ["https://www.ebay.com/sch/i.html?_nkw=x"] },
      ],
    }
    const moved = {
      ...PLAIN,
      uncertain: ["Search listings on eBay suggest sold prices near $40."],
    }
    expect(withBarredSites(moved, [])).toEqual([])
    expect(withBarredSites(moved, [], draft)).toEqual([ebay])
  })

  it("starts no wait for a negation that is not about the site", () => {
    for (const line of [
      "The deluxe edition is not common on eBay; most sell for $40.",
      "Prices do not vary much: eBay sold listings average $40.",
      "eBay is the main resale market, and the base game is unavailable in stores.",
      "BGG ranks it third, though the game is not in print anymore.",
      "The game has a BoardGameGeek weight of 2.4, which is not heavy.",
    ]) {
      expect(withBarredSites(withSummary(line), []), line).toEqual([])
    }
    const users = { ...PLAIN, uncertain: ["BGG users do not agree on the expansion's value."] }
    expect(withBarredSites(users, [])).toEqual([])
  })

  it("matches an entry's site name too, whatever host its URL is on", () => {
    const archived = [
      { site: "BoardGameGeek", url: `https://web.archive.org/web/2026/${BGG}`, why: "403" },
    ]
    expect(withBarredSites(T8, archived)).toEqual(archived)
  })

  it("adds eBay where it is named as unread, or a claim rests only on eBay", () => {
    expect(
      withBarredSites({ ...PLAIN, uncertain: ["Sold prices on eBay were not looked at."] }, []),
    ).toEqual([ebay])
    const onlyEbay = {
      ...PLAIN,
      findings: [{ claim: "It sells for about 40 USD.", sources: [EBAY_ITEM] }],
    }
    expect(withBarredSites(onlyEbay, [])).toEqual([ebay])
    const ukOnly = {
      ...PLAIN,
      findings: [{ claim: "Sold for 40 GBP.", sources: ["https://www.ebay.co.uk/itm/1"] }],
    }
    expect(withBarredSites(ukOnly, [])).toEqual([ebay])
    // A fully qualified host is the same site.
    const dotted = {
      ...PLAIN,
      findings: [{ claim: "About 40 USD.", sources: ["https://www.ebay.com./itm/1"] }],
    }
    expect(withBarredSites(dotted, [])).toEqual([ebay])
  })

  it("leaves a passing mention of eBay alone, and gives eBay no cited exemption", () => {
    // A passing mention starts no 14-day wait.
    const passing = withSummary("It is also sold on eBay and in shops.")
    expect(withBarredSites(passing, [])).toEqual([])
    // A claim with an eBay address and an opened one does not rest only on eBay.
    const mixed = {
      ...PLAIN,
      findings: [{ claim: "About 40 USD.", sources: ["https://shop.example/x", EBAY_ITEM] }],
    }
    expect(withBarredSites(mixed, [])).toEqual([])
    // Named as unread while a finding cites an eBay address: still added (it was never opened).
    const cited = {
      ...mixed,
      uncertain: ["eBay could not be opened."],
    }
    expect(withBarredSites(cited, [])).toEqual([ebay])
  })

  it("adds nothing when an entry already lists the site, by name, host or URL", () => {
    expect(withBarredSites(T8, BLOCKED)).toEqual(BLOCKED)
    const byName = [{ site: "BoardGameGeek", why: "403" }]
    expect(withBarredSites(T8, byName)).toEqual(byName)
    const byUrl = [{ site: "the year's ranking", url: BGG, why: "403" }]
    expect(withBarredSites(T8, byUrl)).toEqual(byUrl)
  })

  it("adds nothing to an answer that names no barred site", () => {
    expect(withBarredSites(PLAIN, [])).toEqual([])
    const near = withSummary("An eBayer's notebook could not be checked; the bggs are not a site.")
    expect(withBarredSites(near, [])).toEqual([])
  })

  it("never grows the list past MAX_BLOCKED", () => {
    const full = Array.from({ length: MAX_BLOCKED }, (_, i) => ({
      site: `site${i}.example`,
      why: "403",
    }))
    expect(withBarredSites(T8, full)).toEqual(full)
  })

  it("is built on BARRED_SITES", () => {
    expect(BGG_SITE?.everywhere).toBe(false)
    expect(BARRED_SITES[1]?.everywhere).toBe(true)
  })
})

describe("one entry per page", () => {
  it("keys an entry by its page when it has a URL, by its site when not", () => {
    expect(blockedKey({ site: "BoardGameGeek", why: "" })).toBe("boardgamegeek.com")
    // A fully qualified host is the same site and the same page (docket#52).
    expect(blockedKey({ site: "shop.example.", why: "" })).toBe("shop.example")
    expect(blockedKey({ site: "ebay.com.", why: "" })).toBe("ebay.com")
    expect(blockedKey({ site: "x", url: "https://shop.example./a", why: "" })).toBe(
      blockedKey({ site: "x", url: "https://shop.example/a", why: "" }),
    )
    expect(blockedKey({ site: "BGG", why: "" })).toBe("boardgamegeek.com")
    expect(blockedKey({ site: "boardgamegeek.com", why: "" })).toBe("boardgamegeek.com")
    expect(blockedKey({ site: "eBay", why: "" })).toBe("ebay.com")
    expect(blockedKey({ site: "ebay.co.uk", why: "" })).toBe("ebay.com")
    expect(blockedKey({ site: "x", url: BGG, why: "" })).toBe("boardgamegeek.com/browse/boardgame")
    expect(
      blockedKey({ site: "x", url: "https://www.boardgamegeek.com/browse/boardgame/", why: "" }),
    ).toBe("boardgamegeek.com/browse/boardgame")
    expect(blockedKey({ site: "www.Example.org", why: "" })).toBe("example.org")
    // Only the known aliases merge: two shops on two TLDs stay two sites.
    expect(blockedKey({ site: "amazon.de", why: "" })).not.toBe(
      blockedKey({ site: "amazon.co.uk", why: "" }),
    )
  })

  it("merges a URL-less entry into one on its site, and keeps two pages on one site", () => {
    const rank = { site: "boardgamegeek.com", url: BGG, why: "b" }
    const game = { site: "BGG", url: "https://boardgamegeek.com/boardgame/1/example", why: "e" }
    expect(
      uniqueBlocked([
        { site: "BoardGameGeek", why: "a" },
        rank,
        game,
        { site: "eBay", why: "c" },
        { site: "ebay.co.uk", why: "d" },
        { ...rank, url: `${BGG}&page=2`, why: "same page" },
        { site: "BGG", why: "after" },
      ]),
    ).toEqual([rank, game, { site: "eBay", why: "c" }])
    expect(
      uniqueBlocked([
        { site: "amazon.de", why: "" },
        { site: "amazon.co.uk", why: "" },
      ]),
    ).toHaveLength(2)
  })
})

describe("a first pass whose best source was not opened", () => {
  it("t8's answer waits for pages, the belt's entry in the Couldn't open list", async () => {
    const r = await run([ok(T8), approve(T8)], noPages)
    expect(r.texts).toHaveLength(1)
    expect(r.text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(r.text).toContain(`Couldn't open:\n- boardgamegeek.com: ${NOT_OPENED_WHY}`)
    expect(r.text).toContain("A fuller pass is queued")
    const state = researchState(r.after?.state)
    expect(state.phase).toBe("awaiting-pages")
    expect(state.blocked).toEqual([{ site: "boardgamegeek.com", why: NOT_OPENED_WHY }])
  })

  it("still waits when the reviewer rewords the unread line away", async () => {
    const reworded = { ...T8, uncertain: ["No rating-based ranking was available."] }
    const r = await run([ok(T8), revise(reworded)], noPages)
    expect(r.text).toContain("No rating-based ranking was available.")
    expect(r.text).toContain(`- boardgamegeek.com: ${NOT_OPENED_WHY}`)
    expect(researchState(r.after?.state).phase).toBe("awaiting-pages")
  })

  it("a reviewer's revise may add the best source, and that starts the wait", async () => {
    const entry = { site: "boardgamegeek.com", url: BGG, why: "the reference for board games" }
    const r = await run([ok(PLAIN), revise({ ...PLAIN, blocked: [entry] })], noPages)
    expect(r.text).toContain(`- boardgamegeek.com: the reference for board games <${BGG}>`)
    expect(researchState(r.after?.state)).toMatchObject({
      phase: "awaiting-pages",
      blocked: [entry],
    })
  })

  it("a reviewer's revise cannot drop the research run's list", async () => {
    const r = await run([ok({ ...PLAIN, blocked: BLOCKED }), revise(PLAIN)], noPages)
    expect(researchState(r.after?.state)).toMatchObject({
      phase: "awaiting-pages",
      blocked: BLOCKED,
    })
  })

  it("keeps both lists on a revise, one entry per site", async () => {
    const extra = { site: "ebay.com", why: "listings" }
    const again = { site: "BoardGameGeek", why: "the reference" }
    const r = await run(
      [ok({ ...PLAIN, blocked: BLOCKED }), revise({ ...PLAIN, blocked: [again, extra] })],
      noPages,
    )
    expect(researchState(r.after?.state).blocked).toEqual([...BLOCKED, extra])
  })

  it("never waits on a request made on gathered pages, belt or not", async () => {
    const r = await run([ok(T8), approve(T8)], async () => PAGES, SENT)
    expect(r.text).not.toContain("Couldn't open")
    expect(r.text).toContain(T8.uncertain[0])
    expect(r.after?.status).toBe("done")
  })

  it("without a store to read pages from, runs as before", async () => {
    const r = await run([ok(T8), approve(T8)])
    expect(r.text).not.toContain("Couldn't open")
    expect(r.after?.status).toBe("done")
  })
})
