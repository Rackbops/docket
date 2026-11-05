import type { JobResult, JobSpec, NoJob, Outcome } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"
import {
  JUDGE_DETAIL_CHARS,
  type JudgeState,
  judgeJob,
  type Listing,
  type ListingDetail,
  MAX_WANT_NOTES,
  parseEbayItem,
  type Source,
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

/** A source whose search finds `found` and whose full reads come from `live` (gone when absent). */
function source(found: Listing[], live: Map<string, Listing>) {
  const reads: string[] = []
  const s: Source = {
    id: "ebay",
    search: async () => found,
    detail: async (l): Promise<ListingDetail | null> => {
      reads.push(l.ref ?? "")
      const now = [...live.values()].find((x) => x.ref === l.ref)
      if (!now) return null
      return {
        text: `Item specifics for ${now.title}. Contents: all cards, sealed.`,
        shipping: "free shipping",
        listing: { ...now, shipping: "free shipping" },
      }
    },
  }
  return { s, reads }
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
    expect(JSON.stringify(held)).not.toMatch(/Arkham|seller_a|Used|itm/)

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
    expect(JSON.stringify(after)).not.toContain("Arkham")
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
    expect(JSON.stringify(waiting)).not.toContain("Arkham")

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
    expect(JSON.stringify(state)).not.toContain("Arkham")
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
