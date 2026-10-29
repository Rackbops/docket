import { describe, expect, it } from "vitest"
import {
  isExcluded,
  type Listing,
  MAX_EXCLUDE,
  parseExclude,
  SOURCE_IDS,
  type Source,
  type SourceId,
  wantjudgeType,
  wantlistType,
} from "../src/index.js"

/**
 * Exclude words on want-list watches (docket#77, the Arkham pilot of rackbops-bot-plugins#368): a
 * listing whose title holds an excluded word or phrase is dropped when the source is read, from
 * every source, and a watch with no `exclude` behaves as before. A stub stands in for each source:
 * the filter runs on what `search` returns, whichever source returned it.
 */

const listing = (title: string, url: string, price = 40): Listing => ({
  id: url,
  title,
  url,
  price,
  currency: "USD",
})
const CAMPAIGN = listing("Edge of the Earth Campaign Expansion", "https://shop.example/p/campaign")
const INVESTIGATOR = listing(
  "Edge of the Earth Investigator Expansion",
  "https://shop.example/p/investigator",
)

const stub = (id: SourceId): Source => ({ id, search: async () => [CAMPAIGN, INVESTIGATOR] })
const ctx = (config: Record<string, unknown>, dedupeKey = "2026-10-29T00:00:00.000Z") =>
  ({
    task: { id: "t1", title: "Edge of the Earth" },
    occurrence: { dedupeKey },
    config,
    state: null,
    ports: {},
    now: new Date("2026-10-29T00:00:00.000Z"),
  }) as never

describe("isExcluded", () => {
  it("matches whole words in order, folding case, accents and punctuation", () => {
    expect(isExcluded("Edge of the Earth: Investigator Expansion", ["investigator"])).toBe(true)
    expect(
      isExcluded("Edge of the Earth: INVESTIGATOR Expansion", ["Investigator expansion"]),
    ).toBe(true)
    expect(isExcluded("Pokémon booster", ["pokemon"])).toBe(true)
    expect(isExcluded("Edge of the Earth Campaign Expansion", ["investigator"])).toBe(false)
    expect(isExcluded("Edge of the Earth Investigators", ["investigator"])).toBe(false)
    expect(isExcluded("Expansion Investigator", ["investigator expansion"])).toBe(false)
  })

  it("excludes nothing without a list, for an empty entry, or for a stored value of the wrong shape", () => {
    expect(isExcluded("Investigator", undefined)).toBe(false)
    expect(isExcluded("Investigator", [])).toBe(false)
    expect(isExcluded("Investigator", ["", " -- "])).toBe(false)
    expect(isExcluded("Investigator", { investigator: true })).toBe(false)
    expect(isExcluded("Investigator", [7, null])).toBe(false)
  })

  it("reads a stored string as one comma-separated field", () => {
    expect(isExcluded("Edge of the Earth Investigator Expansion", "promo, investigator")).toBe(true)
    expect(isExcluded("Edge of the Earth Campaign Expansion", "promo, investigator")).toBe(false)
    expect(isExcluded("Investigator", "")).toBe(false)
  })

  it("reads at most MAX_EXCLUDE entries", () => {
    const many = [...Array.from({ length: MAX_EXCLUDE }, (_, i) => `w${i}`), "investigator"]
    expect(isExcluded("Investigator", many)).toBe(false)
  })
})

describe("parseExclude", () => {
  it("splits at commas and line breaks, trims, and drops empty and repeated entries", () => {
    expect(parseExclude("investigator, Investigator,\n,  starter deck ,")).toEqual([
      "investigator",
      "starter deck",
    ])
    expect(parseExclude("")).toEqual([])
    expect(parseExclude(Array.from({ length: 30 }, (_, i) => `w${i}`).join(","))).toHaveLength(
      MAX_EXCLUDE,
    )
  })
})

describe("exclude words on a plain watch, from every source", () => {
  for (const id of SOURCE_IDS) {
    it(`drops the investigator expansion and keeps the campaign one (${id})`, async () => {
      const type = wantlistType({ [id]: stub(id) })
      const out = await type.run(
        ctx({ source: id, target: "edge of the earth", exclude: ["investigator"] }),
      )
      expect(out.notify?.text).toContain("Campaign Expansion")
      expect(out.notify?.text).not.toContain("Investigator")
      expect(out.summary).toBe("2 listed, 2 within limits, 1 excluded, 1 new")
      expect((out.state as { reported: string[] }).reported).toHaveLength(1)
      if (id === "ebay") expect(out.findings).toBeUndefined()
      else expect(out.findings?.map((f) => f.source)).toEqual([CAMPAIGN.url])
    })
  }

  it("tells of both without exclude, as before", async () => {
    const type = wantlistType({ page: stub("page") })
    const out = await type.run(ctx({ source: "page", target: "https://shop.example/s" }))
    expect(out.summary).toBe("2 listed, 2 within limits, 2 new")
    expect(out.findings).toHaveLength(2)
  })

  it("excludes from a stored comma-separated string too", async () => {
    const type = wantlistType({ page: stub("page") })
    const out = await type.run(
      ctx({ source: "page", target: "https://shop.example/s", exclude: "promo, investigator" }),
    )
    expect(out.summary).toBe("2 listed, 2 within limits, 1 excluded, 1 new")
  })

  it("ends quietly when every new listing is excluded", async () => {
    const type = wantlistType({ page: stub("page") })
    const out = await type.run(
      ctx({ source: "page", target: "https://shop.example/s", exclude: ["edge"] }),
    )
    expect(out.notify).toBeUndefined()
    expect(out.summary).toBe("2 listed, 2 within limits, 2 excluded, 0 new")
  })
})

describe("exclude words on a judged watch, from every source", () => {
  for (const id of SOURCE_IDS) {
    it(`never sends the investigator expansion to the judge (${id})`, async () => {
      const type = wantjudgeType({ [id]: stub(id) })
      const out = (await type.prepare?.(
        ctx({ source: id, target: "edge of the earth", exclude: ["investigator"] }),
      )) as { outcome: { state: { pending: Listing[] }; summary: string } }
      expect(out.outcome.state.pending.map((l) => l.title)).toEqual([CAMPAIGN.title])
      expect(out.outcome.summary).toContain("1 excluded, 1 new")
    })
  }

  it("drops a pending listing that an edit excluded since the read", async () => {
    const type = wantjudgeType({ page: stub("page") })
    const pending = {
      reported: [],
      misses: 0,
      told: 0,
      warned: false,
      pending: [CAMPAIGN, INVESTIGATOR],
      failures: 0,
    }
    const config = { source: "page", target: "https://shop.example/s", exclude: ["investigator"] }
    const result = {
      kind: "success",
      result: "",
      structuredOutput: {
        verdicts: [
          { n: 1, fit: "match", why: "campaign box" },
          { n: 2, fit: "match", why: "same name" },
        ],
      },
      durationMs: 1,
    } as const
    const done = (await type.finish?.(
      { ...(ctx(config, "followup:o1") as object), state: pending } as never,
      result,
    )) as { notify?: { text: string }; state: { reported: string[] } }
    expect(done.notify?.text).toContain("Campaign Expansion")
    expect(done.notify?.text).not.toContain("Investigator")
    expect(done.state.reported).toHaveLength(1)
    const failed = { kind: "budget_cap", detail: "over", durationMs: 1 } as const
    const gave = (await type.finish?.(
      { ...(ctx(config, "followup:o1") as object), state: { ...pending, failures: 9 } } as never,
      failed,
    )) as { notify?: { text: string }; state: { reported: string[] } }
    expect(gave.notify?.text).toContain("Campaign Expansion")
    expect(gave.notify?.text).not.toContain("Investigator")
  })
})
