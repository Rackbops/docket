import {
  createTask,
  type Executor,
  type JobResult,
  Lanes,
  MemoryStore,
} from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"

import {
  BARRED_SITES,
  type GatheredPage,
  MAX_BLOCKED,
  NOT_OPENED_WHY,
  type ReadSources,
  type ResearchConfig,
  researchJob,
  researchState,
  researchType,
  reviewJob,
  SENT_DISALLOWED_TOOLS,
  TASK_TYPES,
  WEB_DISALLOWED_TOOLS,
  withBarredSites,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, T0 } from "./helpers.js"

const WEB: ResearchConfig = {
  question: "what is the best boardgame released in 2026, in each of the major categories",
}
const BGG = "https://boardgamegeek.com/browse/boardgame?sort=rank&year=2026"

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

function ok(structuredOutput: unknown, totalCostUsd = 0.3): JobResult {
  return { kind: "success", result: "done", structuredOutput, totalCostUsd, durationMs: 1000 }
}
const approve = (answer: unknown) => ok({ verdict: "approve", problems: [], answer }, 0.1)
const revise = (answer: unknown) =>
  ok({ verdict: "revise", problems: ["the best source is missing"], answer }, 0.1)

function scripted(...answers: JobResult[]): Executor {
  return {
    run: async () => {
      const next = answers.shift()
      if (!next) throw new Error("the test ran out of recorded results")
      return next
    },
  }
}

async function run(executor: Executor, readSources?: ReadSources, config: ResearchConfig = WEB) {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const type = researchType(readSources ? { readSources } : {})
  const larry = await store.createUser({ discordId: "d-larry", at: T0 })
  const lanes = new Lanes({
    store,
    clock,
    types: { ...TASK_TYPES, research: type },
    notifier,
    executor,
  })
  const { task } = await createTask(
    store,
    actor(larry),
    larry,
    { type, title: "Best of 2026", config, schedule: { kind: "once", at: T0 } },
    clock.now(),
  )
  await lanes.tickExecute()
  await lanes.tickExecute()
  const after = await store.getTask(task.id)
  return { text: notifier.sent[0]?.message.text ?? "", sent: notifier.sent, after }
}

const PAGES: GatheredPage[] = [
  { url: BGG, title: "Board game rank, 2026", text: "1. Example Game (2026), rated 8.4." },
]

describe("the research run names the best source (0.10.0)", () => {
  it("picks the field's reference site, and lists a barred one in `blocked` with a URL", () => {
    const prompt = researchJob(WEB).prompt
    expect(prompt).toContain("decide first which source is the best one for it")
    expect(prompt).toContain("for board games, BoardGameGeek; for listings and sold prices, eBay")
    // A web first pass tries BoardGameGeek (Rod, 2026-10-16) and never tries eBay.
    expect(prompt).toContain("Open BoardGameGeek like any other site: an ordinary read")
    expect(prompt).toContain("eBay is not opened from this run: do not try it.")
    expect(prompt).not.toContain("BoardGameGeek and eBay are not opened")
    expect(prompt).toContain("list it in `blocked` with its site, the page's URL when you can")
    expect(prompt).toContain("BoardGameGeek's ranking or browse page for the year")
    expect(prompt).toContain(
      "a 403, a CAPTCHA or challenge page, an empty or blocked body, a sign-in wall",
    )
    expect(prompt).toContain('Never write in `summary` or `uncertain` that you "didn\'t check" it')
    // It comes before the search instruction.
    expect(prompt.indexOf("best one for it")).toBeLessThan(prompt.indexOf("Use web search"))
  })

  it("on gathered pages, both stay barred, listed only when no page is from them", () => {
    for (const prompt of [
      researchJob({ ...WEB, sources: "sent" }, PAGES).prompt,
      researchJob(WEB, PAGES, PLAIN).prompt,
    ]) {
      expect(prompt).toContain("BoardGameGeek and eBay are not opened from this run: do not try.")
      expect(prompt).toContain("one of them and no gathered page is from it")
      expect(prompt).not.toContain("Open BoardGameGeek like any other site")
    }
    expect(researchJob(WEB).prompt).not.toContain("no gathered page is from it")
  })

  it("a web first pass and its reviewer may fetch BoardGameGeek; page runs may not", () => {
    const bgg = (tools: string[]) => tools.some((t) => /boardgamegeek|geekdo/.test(t))
    expect(bgg(researchJob(WEB).disallowedTools ?? [])).toBe(false)
    expect(bgg(reviewJob(WEB, T8).disallowedTools ?? [])).toBe(false)
    expect(reviewJob(WEB, T8).prompt).toContain("You may open BoardGameGeek like any site.")
    // eBay is barred for every run, the web first pass and its reviewer included.
    expect(WEB_DISALLOWED_TOOLS).toEqual(
      ["ebay.*", "*.ebay.*", "ebay.co.*", "*.ebay.co.*", "ebay.com.*", "*.ebay.com.*"].map(
        (h) => `WebFetch(domain:${h})`,
      ),
    )
    expect(researchJob(WEB).disallowedTools).toEqual(expect.arrayContaining(WEB_DISALLOWED_TOOLS))
    expect(reviewJob(WEB, T8).disallowedTools).toEqual(expect.arrayContaining(WEB_DISALLOWED_TOOLS))
    for (const tools of [
      researchJob({ ...WEB, sources: "sent" }, PAGES).disallowedTools,
      researchJob(WEB, PAGES, PLAIN).disallowedTools,
      reviewJob({ ...WEB, sources: "sent" }, T8, PAGES).disallowedTools,
      reviewJob(WEB, T8, PAGES, PLAIN).disallowedTools,
    ]) {
      expect(tools).toEqual(expect.arrayContaining(SENT_DISALLOWED_TOOLS))
    }
  })

  it("keeps the tool denials as they were, now built from BARRED_SITES", () => {
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

describe("the first pass's reviewer checks the best source (0.10.0)", () => {
  it("revises an answer that leans on secondary sources without it", () => {
    const prompt = reviewJob(WEB, T8).prompt
    expect(prompt).toContain("Name the best source for each part")
    expect(prompt).toContain(
      "neither among its findings' sources nor in `blocked`, the verdict is `revise`: add it to " +
        "`blocked`",
    )
    expect(prompt).toContain('("I didn\'t check BoardGameGeek") is no answer: move it to `blocked`')
  })

  it("is not asked on gathered pages nor of an update", () => {
    expect(reviewJob({ ...WEB, sources: "sent" }, T8, PAGES).prompt).not.toContain(
      "Name the best source",
    )
    expect(reviewJob(WEB, T8, PAGES, PLAIN).prompt).not.toContain("Name the best source")
  })
})

describe("withBarredSites, the belt", () => {
  const added = { site: "boardgamegeek.com", why: NOT_OPENED_WHY }

  it("adds BoardGameGeek only where the summary or `uncertain` says it was not read", () => {
    expect(withBarredSites(T8, [])).toEqual([added])
    for (const summary of [
      "BGG refused the request (403), so the ranking is from reviews.",
      "Example Game leads. BoardGameGeek could not be opened.",
      "The BoardGameGeek ranking was not checked.",
    ]) {
      expect(withBarredSites({ ...PLAIN, summary }, [])).toEqual([added])
    }
    // Named in passing, not as unread: left alone (the run may have read it without citing it).
    const passing = { ...PLAIN, summary: "Ranked by BGG users, Example Game leads." }
    expect(withBarredSites(passing, [])).toEqual([])
    // An unread marker in another sentence does not count.
    const apart = { ...PLAIN, summary: "Ranked by BGG users. The publisher's page was blocked." }
    expect(withBarredSites(apart, [])).toEqual([])
    // A claim is not where the run says what it could not read.
    const claim = {
      ...PLAIN,
      findings: [
        { claim: "BoardGameGeek did not list it before May.", sources: ["https://example.org"] },
      ],
    }
    expect(withBarredSites(claim, [])).toEqual([])
  })

  it("adds eBay wherever the answer names it, since no run opens it", () => {
    const ebay = { ...PLAIN, uncertain: ["Sold prices on eBay were not looked at."] }
    expect(withBarredSites(ebay, [])).toEqual([{ site: "ebay.com", why: NOT_OPENED_WHY }])
    const inClaim = {
      ...PLAIN,
      findings: [{ claim: "It sells for about 40 USD on eBay.", sources: ["https://example.org"] }],
    }
    expect(withBarredSites(inClaim, [])).toEqual([{ site: "ebay.com", why: NOT_OPENED_WHY }])
  })

  it("leaves a site that a finding cites, even when it is also named in passing", () => {
    const cited = {
      ...T8,
      findings: [
        ...T8.findings,
        { claim: "BoardGameGeek rates Example Game 8.4.", sources: [BGG] },
      ],
    }
    expect(withBarredSites(cited, [])).toEqual([])
    const geekdo = {
      ...T8,
      findings: [{ claim: "Its cover art.", sources: ["https://cf.geekdo-images.com/x.jpg"] }],
    }
    // geekdo-images.com is not geekdo.com: that is no BGG page opened.
    expect(withBarredSites(geekdo, [])).toEqual([added])
    const ebayUk = {
      ...PLAIN,
      summary: "eBay sold prices average 40 GBP.",
      findings: [{ claim: "Sold for 40 GBP.", sources: ["https://www.ebay.co.uk/itm/1"] }],
    }
    expect(withBarredSites(ebayUk, [])).toEqual([])
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
    // Words that only contain the names are not them.
    const near = { ...PLAIN, summary: "An eBayer's notebook; the bggs are not a site." }
    expect(withBarredSites(near, [])).toEqual([])
  })

  it("never grows the list past MAX_BLOCKED", () => {
    const full = Array.from({ length: MAX_BLOCKED }, (_, i) => ({
      site: `site${i}.example`,
      why: "403",
    }))
    expect(withBarredSites(T8, full)).toEqual(full)
  })
})

describe("a first pass whose best source was not opened", () => {
  it("t8's answer waits for pages, the belt's entry in the Couldn't open list", async () => {
    const r = await run(scripted(ok(T8), approve(T8)), async () => [])
    expect(r.sent).toHaveLength(1)
    expect(r.text).toContain(`Couldn't open:\n- boardgamegeek.com: ${NOT_OPENED_WHY}`)
    expect(r.text).toContain("A fuller pass is queued")
    const state = researchState(r.after?.state)
    expect(state.phase).toBe("awaiting-pages")
    expect(state.blocked).toEqual([{ site: "boardgamegeek.com", why: NOT_OPENED_WHY }])
  })

  it("a reviewer's revise may add the best source, and that starts the wait", async () => {
    const entry = { site: "boardgamegeek.com", url: BGG, why: "the reference for board games" }
    const r = await run(scripted(ok(PLAIN), revise({ ...PLAIN, blocked: [entry] })), async () => [])
    expect(r.text).toContain(`- boardgamegeek.com: the reference for board games <${BGG}>`)
    expect(researchState(r.after?.state)).toMatchObject({
      phase: "awaiting-pages",
      blocked: [entry],
    })
  })

  it("a reviewer's revise cannot drop the research run's list", async () => {
    const r = await run(scripted(ok({ ...PLAIN, blocked: BLOCKED }), revise(PLAIN)), async () => [])
    expect(researchState(r.after?.state)).toMatchObject({
      phase: "awaiting-pages",
      blocked: BLOCKED,
    })
  })

  it("keeps both lists on a revise, each site and URL once", async () => {
    const extra = { site: "ebay.com", why: "listings" }
    const r = await run(
      scripted(
        ok({ ...PLAIN, blocked: BLOCKED }),
        revise({ ...PLAIN, blocked: [...BLOCKED, extra] }),
      ),
      async () => [],
    )
    expect(researchState(r.after?.state).blocked).toEqual([...BLOCKED, extra])
  })

  it("never waits on a request made on gathered pages, belt or not", async () => {
    const r = await run(scripted(ok(T8), approve(T8)), async () => PAGES, {
      ...WEB,
      sources: "sent",
    })
    expect(r.text).not.toContain("Couldn't open")
    expect(r.after?.status).toBe("done")
  })

  it("without a store to read pages from, runs as before", async () => {
    const r = await run(scripted(ok(T8), approve(T8)))
    expect(r.text).not.toContain("Couldn't open")
    expect(r.after?.status).toBe("done")
  })
})
