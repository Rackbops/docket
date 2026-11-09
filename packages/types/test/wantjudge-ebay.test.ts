import type { JobResult, JobSpec, NoJob, Outcome } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  ebaySource,
  JUDGE_DETAIL_CHARS,
  type JudgeState,
  judgeJob,
  type Listing,
  type ListingDetail,
  ListingUnreadable,
  MAX_WANT_NOTES,
  parseEbayItem,
  type Source,
  SourceMiss,
  wantjudgeType,
} from "../src/index.js"

/**
 * The judged eBay watch (rackbops-bot-plugins#368, gaps L1 and L3): between its two runs it keeps
 * eBay's item numbers only, reads each listing back in full for the model and again for the DM,
 * and gives the model the owner's notes.
 */

const item = (n: number, title: string, seller = "seller_a"): Listing => ({
  id: `ebay:${100000 + n}`,
  title,
  url: `https://www.ebay.com/itm/${100000 + n}`,
  ref: `v1|${100000 + n}|0`,
  price: 50 + n,
  currency: "USD",
  condition: "Used",
  seller: `${seller}, 99.5% positive, 120 feedback`,
})

const CAMPAIGN = item(1, "Arkham Horror Edge of the Earth Campaign Expansion")
const BUNDLE = item(2, "Arkham Edge of the Earth Investigator + Campaign lot")
const INVESTIGATOR = item(3, "Arkham Horror Edge of the Earth Investigator Expansion")

const NOTES =
  "Complete copies only. An Investigator box alone is not wanted, but a bundle with the campaign box is. Skip collector gouging."
const CONFIG = {
  source: "ebay" as const,
  target: "arkham horror edge of the earth",
  exclude: ["proxy"],
  notes: NOTES,
}

/**
 * A source whose search finds `found` and whose full reads come from `live` (gone when absent);
 * while `down.on` is set, every read fails as eBay being busy would.
 */
function source(found: Listing[], live: Map<string, Listing>) {
  const reads: string[] = []
  const down = { on: false }
  const s: Source = {
    id: "ebay",
    search: async () => found,
    reread: async (l): Promise<ListingDetail | null> => {
      reads.push(l.ref ?? "")
      if (down.on) throw new SourceMiss("eBay is busy (HTTP 503)")
      const now = [...live.values()].find((x) => x.ref === l.ref)
      if (!now) return null
      return {
        text: `Item specifics for ${now.title}. Contents: all cards, sealed.`,
        shipping: "free shipping",
        listing: { ...now, shipping: "free shipping" },
      }
    },
  }
  return { s, reads, down }
}

const SCHEDULED = "2026-11-06T13:00:00.000Z"
const FOLLOW_UP = "followup:o1"

const ctx = (dedupeKey: string, state: unknown, config: Record<string, unknown> = CONFIG) =>
  ({
    task: { id: "t15", title: "Arkham Edge of the Earth" },
    occurrence: { dedupeKey },
    config,
    // As stored between runs.
    state: state === null ? null : JSON.parse(JSON.stringify(state)),
    ports: {},
    now: new Date("2026-11-06T13:00:00.000Z"),
  }) as never

const success = (structuredOutput: unknown): JobResult => ({
  kind: "success",
  result: "",
  structuredOutput,
  durationMs: 1,
})

const lookOnce = async (type: ReturnType<typeof wantjudgeType>) =>
  (await type.prepare?.(ctx(SCHEDULED, null))) as NoJob

/** Any title, seller, condition, price or address of a listing. */
const LISTING_TEXT = /Arkham|seller_a|Used|itm|USD|shipping/

const verdict = (n: number, fit: string, why = "checked") => ({ n, fit, why, seller: "not shown" })

describe("the judged eBay watch keeps item numbers only", () => {
  it("reads back each listing a getItem answer describes", () => {
    const d = parseEbayItem({
      itemId: "v1|123456789012|0",
      title: "Arkham Horror Edge of the Earth",
      itemWebUrl: "https://www.ebay.com/itm/123456789012",
      price: { value: "60.00", currency: "USD" },
      condition: "Used",
      seller: { username: "seller_a", feedbackPercentage: "99.5", feedbackScore: 120 },
      shippingOptions: [{ shippingCost: { value: "7.50", currency: "USD" } }],
    })
    expect(d?.listing).toEqual({
      id: "ebay:123456789012",
      title: "Arkham Horror Edge of the Earth",
      url: "https://www.ebay.com/itm/123456789012",
      ref: "v1|123456789012|0",
      price: 60,
      currency: "USD",
      condition: "Used",
      seller: "seller_a, 99.5% positive, 120 feedback",
      shipping: "7.50 USD shipping",
    })
    expect(parseEbayItem({ itemId: "v1|1|0", title: "no address" })?.listing).toBeUndefined()
  })

  it("holds the new listings' numbers, reads them in full for the model, and keeps nothing of them", async () => {
    const live = new Map([CAMPAIGN, BUNDLE, INVESTIGATOR].map((l) => [l.id, l]))
    const { s, reads } = source([CAMPAIGN, BUNDLE, INVESTIGATOR], live)
    const type = wantjudgeType({ ebay: s })

    const look = (await type.prepare?.(ctx(SCHEDULED, null))) as NoJob
    const held = look.outcome.state as JudgeState
    expect(reads).toEqual([])
    expect(held.pending).toEqual([])
    expect(held.held.map((h) => h.id)).toEqual([CAMPAIGN.id, BUNDLE.id, INVESTIGATOR.id])
    expect(look.outcome.followUp).toEqual({})
    expect(look.outcome.summary).toContain("3 new; checking them")
    // No title, seller or price of any listing is in the state.
    expect(JSON.stringify(held)).not.toMatch(LISTING_TEXT)

    const job = (await type.prepare?.(ctx(FOLLOW_UP, held))) as JobSpec
    expect(reads).toEqual([CAMPAIGN.ref, BUNDLE.ref, INVESTIGATOR.ref])
    expect(job.prompt).toContain(`Their notes on what counts`)
    expect(job.prompt).toContain("Complete copies only.")
    expect(job.prompt).toContain("or anything their notes rule out")
    expect(job.prompt).toContain(`1. ${CAMPAIGN.title} | 51.00 USD | free shipping | Used`)
    expect(job.prompt).toContain(
      "   Full listing: Item specifics for Arkham Horror Edge of the Earth Campaign",
    )
    expect(job.prompt).toContain(`3. ${INVESTIGATOR.title}`)
    expect(job.disallowedTools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]))

    // The bundle sells before the answer comes back: dropped, and the verdicts still map by number.
    live.delete(BUNDLE.id)
    const answer = success({
      verdicts: [
        verdict(1, "match", "the campaign box"),
        verdict(2, "match"),
        verdict(3, "no", "investigator box alone"),
      ],
    })
    const out = (await type.finish?.(ctx(FOLLOW_UP, held), answer)) as Outcome
    expect(out.notify?.text).toContain(
      "Arkham Edge of the Earth: a new listing worth a look (1 more did not look like it).",
    )
    expect(out.notify?.text).toContain(CAMPAIGN.title)
    expect(out.notify?.text).toContain("looks right: the campaign box")
    expect(out.notify?.text).not.toContain(BUNDLE.title)
    expect(out.notify?.text).not.toContain(INVESTIGATOR.title)
    expect(out.findings).toBeUndefined()
    const after = out.state as JudgeState
    expect(after.pending).toEqual([])
    expect(after.held).toEqual([])
    // All three remembered, the sold one too: none comes back.
    expect(after.reported).toHaveLength(3)
    expect(JSON.stringify(after)).not.toMatch(LISTING_TEXT)
  })

  it("keeps no runner detail in a failed look's summary, which outlives the six hours (#108)", async () => {
    const live = new Map([CAMPAIGN, BUNDLE].map((l) => [l.id, l]))
    const { s } = source([CAMPAIGN, BUNDLE], live)
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state
    const quoted = `${CAMPAIGN.title} from seller_a; stderr: rate limited`
    for (const kind of [
      "error",
      "turn_cap",
      "budget_cap",
      "schema_miss",
      "timeout",
      "auth_failed",
    ] as const) {
      const failed: JobResult = { kind, detail: quoted, durationMs: 1 }
      let state: unknown = held
      let last = (await type.finish?.(ctx(FOLLOW_UP, state), failed)) as Outcome
      expect(last.summary).toMatch(new RegExp(`^judge ${kind} \\(try 1\\)(;|$)`))
      expect(last.summary).not.toMatch(LISTING_TEXT)
      expect(last.summary).not.toContain("rate limited")
      for (let i = 0; i < 5 && last.followUp; i++) {
        state = last.state
        last = (await type.finish?.(ctx(FOLLOW_UP, state), failed)) as Outcome
        expect(last.summary).not.toMatch(LISTING_TEXT)
        expect(last.summary).not.toContain("rate limited")
      }
      expect(last.followUp).toBeUndefined()
      expect(last.summary).toMatch(
        new RegExp(`^judge ${kind} \\(try \\d+\\); \\d+ sent unchecked$`),
      )
    }
  })

  it("keeps only the numbers while a retry waits, and sends what is still listed unchecked when judging fails for good", async () => {
    const live = new Map([CAMPAIGN, BUNDLE].map((l) => [l.id, l]))
    const { s } = source([CAMPAIGN, BUNDLE], live)
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state
    const failed: JobResult = { kind: "timeout", detail: "slow", durationMs: 1 }
    const retry = (await type.finish?.(ctx(FOLLOW_UP, held), failed)) as Outcome
    const waiting = retry.state as JudgeState
    expect(retry.followUp).toBeDefined()
    expect(waiting.pending).toEqual([])
    expect(waiting.held).toHaveLength(2)
    expect(JSON.stringify(waiting)).not.toMatch(LISTING_TEXT)

    let state: unknown = waiting
    let last: Outcome = retry
    for (let i = 0; i < 5 && last.followUp; i++) {
      last = (await type.finish?.(ctx(FOLLOW_UP, state), failed)) as Outcome
      state = last.state
    }
    expect(last.followUp).toBeUndefined()
    expect(last.notify?.text).toContain("2 new listings, unchecked")
    expect(last.notify?.text).toContain("free shipping")
    expect((state as JudgeState).held).toEqual([])
    expect(JSON.stringify(state)).not.toMatch(LISTING_TEXT)
  })

  it("settles quietly when every held listing is gone before the model looks", async () => {
    const live = new Map([CAMPAIGN].map((l) => [l.id, l]))
    const { s } = source([CAMPAIGN], live)
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state
    live.clear()
    const out = (await type.prepare?.(ctx(FOLLOW_UP, held))) as NoJob
    expect(out.outcome.summary).toBe("nothing to check: the 1 new listing(s) are gone from eBay")
    expect(out.outcome.notify).toBeUndefined()
    expect((out.outcome.state as JudgeState).reported).toHaveLength(1)
    expect((out.outcome.state as JudgeState).held).toEqual([])
  })

  it("ignores a read-back that is not the held listing, and a held entry that is not an eBay item", async () => {
    const other = { ...BUNDLE, ref: CAMPAIGN.ref }
    const live = new Map([[other.id, other]])
    const { s } = source([CAMPAIGN], live)
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state
    const out = (await type.prepare?.(ctx(FOLLOW_UP, held))) as NoJob
    expect(out.outcome.summary).toContain("gone from eBay")
    const bad = {
      held: [
        { id: "ebay:1", ref: "v1|1|0" },
        { id: "page:x", ref: CAMPAIGN.ref },
      ],
    }
    const none = (await type.prepare?.(ctx(FOLLOW_UP, bad))) as NoJob
    expect(none.outcome.summary).toBe("nothing was waiting to be checked")
  })

  it("offers notes at intake, caps them, and a watch with none reads as before", () => {
    const type = wantjudgeType({})
    expect(type.intake?.options.map((o) => o.name)).toContain("notes")
    const long = judgeJob(
      "Wingspan",
      { source: "page", target: "https://shop.example/s", notes: "x".repeat(MAX_WANT_NOTES + 50) },
      [{ id: "a", title: "Wingspan", url: "https://shop.example/p" }],
    )
    expect(long.prompt).toContain("x".repeat(MAX_WANT_NOTES - 3))
    expect(long.prompt).not.toContain("x".repeat(MAX_WANT_NOTES + 1))
    const plain = judgeJob("Wingspan", { source: "page", target: "https://shop.example/s" }, [
      { id: "a", title: "Wingspan", url: "https://shop.example/p" },
    ])
    expect(plain.prompt).not.toContain("Their notes")
    const big = judgeJob("Wingspan", CONFIG, [
      { n: 1, l: CAMPAIGN, detail: "y".repeat(JUDGE_DETAIL_CHARS * 2) },
    ])
    expect(big.prompt).not.toContain("y".repeat(JUDGE_DETAIL_CHARS + 1))
  })
})

describe("a judged eBay watch never takes a failed read for a gone listing", () => {
  it("reads a held listing back through the eBay source: 404 and 410 are gone, busy or refused is a miss, any other answer is unreadable", async () => {
    const answers: Array<{ status: number; body: unknown } | Error> = []
    const s = ebaySource(async () => {
      const a = answers.shift()
      if (a instanceof Error) throw a
      return a ?? { status: 500, body: null }
    })
    const held = { id: "ebay:123456789012", title: "", url: "", ref: "v1|123456789012|0" }
    answers.push({ status: 404, body: null })
    expect(await s.reread?.(held)).toBeNull()
    answers.push({ status: 410, body: null })
    expect(await s.reread?.(held)).toBeNull()
    answers.push({ status: 500, body: null })
    await expect(s.reread?.(held)).rejects.toBeInstanceOf(SourceMiss)
    answers.push({ status: 408, body: null })
    await expect(s.reread?.(held)).rejects.toBeInstanceOf(SourceMiss)
    answers.push({ status: 429, body: null })
    await expect(s.reread?.(held)).rejects.toBeInstanceOf(SourceMiss)
    answers.push(new Error("connection reset https://api.ebay.com/item/v1|123456789012|0"))
    await expect(s.reread?.(held)).rejects.toThrow(/^eBay could not be reached for a held listing$/)
    answers.push({ status: 403, body: null })
    await expect(s.reread?.(held)).rejects.toBeInstanceOf(SourceMiss)
    // Asking again will not help: this one listing is let go, not waited on.
    answers.push({ status: 400, body: null })
    await expect(s.reread?.(held)).rejects.toBeInstanceOf(ListingUnreadable)
    answers.push({ status: 200, body: { itemId: "v1|123456789012|0", title: "no address" } })
    await expect(s.reread?.(held)).rejects.toBeInstanceOf(ListingUnreadable)
    answers.push({
      status: 200,
      body: {
        itemId: "v1|123456789012|0",
        title: "Arkham Horror Edge of the Earth",
        itemWebUrl: "https://www.ebay.com/itm/123456789012",
      },
    })
    expect((await s.reread?.(held))?.listing?.id).toBe("ebay:123456789012")
  })

  it("keeps the numbers held, counts a miss and asks nothing when eBay cannot be read at the look", async () => {
    const live = new Map([CAMPAIGN, BUNDLE].map((l) => [l.id, l]))
    const { s, down } = source([CAMPAIGN, BUNDLE], live)
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state as JudgeState
    down.on = true
    const out = (await type.prepare?.(ctx(FOLLOW_UP, held))) as NoJob
    const after = out.outcome.state as JudgeState
    expect(out.outcome.summary).toContain("nothing read: eBay is busy (HTTP 503)")
    expect(out.outcome.summary).toContain("the 2 new listing(s) wait for the next look")
    expect(out.outcome.followUp).toBeUndefined()
    expect(after.held).toEqual(held.held)
    expect(after.reported).toEqual(held.reported)
    expect(after.misses).toBe(1)
    expect(after.failures).toBe(0)
    expect(JSON.stringify(after)).not.toMatch(LISTING_TEXT)

    // The next scheduled look reads them again and asks the model.
    down.on = false
    const job = (await type.prepare?.(ctx("2026-11-06T14:00:00.000Z", after))) as JobSpec
    expect(job.prompt).toContain(CAMPAIGN.title)
    expect(job.prompt).toContain(BUNDLE.title)
  })

  it("keeps the numbers held when eBay cannot be read once the answer is back, and tells nothing", async () => {
    const live = new Map([CAMPAIGN, BUNDLE].map((l) => [l.id, l]))
    const { s, down } = source([CAMPAIGN, BUNDLE], live)
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state as JudgeState
    await type.prepare?.(ctx(FOLLOW_UP, held))
    down.on = true
    const out = (await type.finish?.(
      ctx(FOLLOW_UP, held),
      success({ verdicts: [verdict(1, "match"), verdict(2, "match")] }),
    )) as Outcome
    const after = out.state as JudgeState
    expect(out.notify).toBeUndefined()
    expect(out.followUp).toBeUndefined()
    expect(after.held).toEqual(held.held)
    expect(after.reported).toEqual(held.reported)
    expect(after.pending).toEqual([])
    expect(JSON.stringify(after)).not.toMatch(LISTING_TEXT)
  })

  it("keeps the numbers held on a bot with no eBay source", async () => {
    const live = new Map([CAMPAIGN].map((l) => [l.id, l]))
    const { s } = source([CAMPAIGN], live)
    const held = (await lookOnce(wantjudgeType({ ebay: s }))).outcome.state as JudgeState
    const bare = wantjudgeType({})
    const look = (await bare.prepare?.(ctx(FOLLOW_UP, held))) as NoJob
    expect((look.outcome.state as JudgeState).held).toEqual(held.held)
    const out = (await bare.finish?.(ctx(FOLLOW_UP, held), success({ verdicts: [] }))) as Outcome
    expect((out.state as JudgeState).held).toEqual(held.held)
    expect((out.state as JudgeState).reported).toEqual(held.reported)
  })

  it("does not remember a listing an edit excluded while the model looked, as for pending", async () => {
    const live = new Map([CAMPAIGN, INVESTIGATOR].map((l) => [l.id, l]))
    const { s } = source([CAMPAIGN, INVESTIGATOR], live)
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state as JudgeState
    const edited = { ...CONFIG, exclude: ["proxy", "investigator"] }
    const out = (await type.finish?.(
      ctx(FOLLOW_UP, held, edited),
      success({ verdicts: [verdict(1, "match"), verdict(2, "match")] }),
    )) as Outcome
    const after = out.state as JudgeState
    expect(out.notify?.text).toContain(CAMPAIGN.title)
    expect(out.notify?.text).not.toContain(INVESTIGATOR.title)
    expect(after.reported).toHaveLength(held.reported.length + 1)
    expect(after.held).toEqual([])
  })

  it("lets go of one listing eBay will never read, unremembered, and judges the rest", async () => {
    const live = new Map([CAMPAIGN, BUNDLE].map((l) => [l.id, l]))
    const { s } = source([CAMPAIGN, BUNDLE], live)
    const reread = s.reread
    s.reread = async (l) => {
      if (l.ref === BUNDLE.ref) throw new ListingUnreadable("eBay answered HTTP 400")
      return (await reread?.(l)) ?? null
    }
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state as JudgeState
    const job = (await type.prepare?.(ctx(FOLLOW_UP, held))) as JobSpec
    expect(job.prompt).toContain(CAMPAIGN.title)
    expect(job.prompt).not.toContain(BUNDLE.title)
    const out = (await type.finish?.(
      ctx(FOLLOW_UP, held),
      success({ verdicts: [verdict(1, "match")] }),
    )) as Outcome
    const after = out.state as JudgeState
    expect(out.notify?.text).toContain(CAMPAIGN.title)
    expect(after.held).toEqual([])
    // Only the told one is remembered: the unreadable one may come back in a later look.
    expect(after.reported).toHaveLength(held.reported.length + 1)

    // Every held listing unreadable: settled at the look, none remembered.
    s.reread = async () => {
      throw new ListingUnreadable("eBay answered HTTP 400")
    }
    const none = (await type.prepare?.(ctx(FOLLOW_UP, held))) as NoJob
    expect(none.outcome.summary).toBe(
      "nothing to check: 0 gone from eBay, 2 could not be read (let go)",
    )
    expect((none.outcome.state as JudgeState).held).toEqual([])
    expect((none.outcome.state as JudgeState).reported).toEqual(held.reported)
  })

  it("neither tells nor remembers a listing the model was not shown (unreadable at the look only)", async () => {
    const live = new Map([CAMPAIGN, BUNDLE].map((l) => [l.id, l]))
    const { s } = source([CAMPAIGN, BUNDLE], live)
    const reread = s.reread
    let bundleFails = true
    s.reread = async (l) => {
      if (l.ref === BUNDLE.ref && bundleFails) throw new ListingUnreadable("eBay answered HTTP 400")
      return (await reread?.(l)) ?? null
    }
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state as JudgeState
    const job = (await type.prepare?.(ctx(FOLLOW_UP, held))) as JobSpec
    expect(job.prompt).not.toContain(BUNDLE.title)
    bundleFails = false
    const out = (await type.finish?.(
      ctx(FOLLOW_UP, held),
      success({ verdicts: [verdict(1, "no", "investigator box alone")] }),
    )) as Outcome
    expect(out.notify).toBeUndefined()
    const after = out.state as JudgeState
    expect(after.held).toEqual([])
    expect(after.reported).toHaveLength(held.reported.length + 1)
  })

  it("takes an answer with no verdict for any listing shown as malformed: retried, then sent unchecked", async () => {
    const live = new Map([CAMPAIGN].map((l) => [l.id, l]))
    const { s } = source([CAMPAIGN], live)
    const type = wantjudgeType({ ebay: s })
    let state: unknown = (await lookOnce(type)).outcome.state
    let out = (await type.finish?.(
      ctx(FOLLOW_UP, state),
      success({ verdicts: [verdict(9, "match")] }),
    )) as Outcome
    expect(out.summary).toContain("no verdict for any listing shown")
    expect(out.followUp).toBeDefined()
    state = out.state
    out = (await type.finish?.(ctx(FOLLOW_UP, state), success({ verdicts: [] }))) as Outcome
    expect(out.followUp).toBeUndefined()
    expect(out.notify?.text).toContain("unchecked")
    expect(out.notify?.text).toContain(CAMPAIGN.title)
  })

  it("asks the model again at the next scheduled look after a failed judge and a failed read", async () => {
    const live = new Map([CAMPAIGN].map((l) => [l.id, l]))
    const { s, down } = source([CAMPAIGN], live)
    const type = wantjudgeType({ ebay: s })
    const held = (await lookOnce(type)).outcome.state
    const timeout: JobResult = { kind: "timeout", detail: "slow", durationMs: 1 }
    const retry = (await type.finish?.(ctx(FOLLOW_UP, held), timeout)) as Outcome
    down.on = true
    const failed = (await type.finish?.(ctx(FOLLOW_UP, retry.state), timeout)) as Outcome
    const after = failed.state as JudgeState
    expect(after.failures).toBe(0)
    expect(after.retryAt).toBeUndefined()
    down.on = false
    const job = (await type.prepare?.(ctx("2026-11-06T14:00:00.000Z", after))) as JobSpec
    expect(job.prompt).toContain(CAMPAIGN.title)
  })

  it("loads at most 20 held numbers", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `ebay:${200000 + i}`,
      ref: `v1|${200000 + i}|0`,
    }))
    const reads: string[] = []
    const s: Source = {
      id: "ebay",
      search: async () => [],
      reread: async (l) => {
        reads.push(l.ref ?? "")
        return null
      },
    }
    await wantjudgeType({ ebay: s }).prepare?.(ctx(FOLLOW_UP, { held: many }))
    expect(reads).toHaveLength(20)
  })
})
