import { describe, expect, it } from "vitest"
import {
  itemKey,
  MAX_SHOWN,
  parseScout,
  renderScout,
  SCOUT_MAX_BUDGET_USD,
  SCOUT_MAX_TURNS,
  scoutJob,
  scoutState,
} from "../src/index.js"

/**
 * The interest scout (category 1): its Job and what it makes of the model's answer. The host's
 * `/scout`, the runs end to end and the editing are the tracker plugin's tests.
 */

describe("the scout's Job and answer", () => {
  it("asks for five to ten items through the lens, names what was shown, and carries the spike's caps", () => {
    const job = scoutJob(
      {
        interests: ["birding", "sourdough"],
        lens: "anniversary",
        for: "Anne <@123>",
        notes: "Under 50 USD",
      },
      { shown: [{ k: "a", t: "Old find" }], failures: 0 },
    )
    expect(job.prompt).toContain("Interests: birding; sourdough.")
    expect(job.prompt).toContain("Lens: anniversary -- with a romantic angle.")
    expect(job.prompt).toContain("at least 5 and at most 10")
    expect(job.prompt).toContain("What the reader added: Under 50 USD")
    expect(job.prompt).toContain("- Old find")
    expect(job.prompt).not.toContain("<@123>")
    expect(job.maxTurns).toBe(SCOUT_MAX_TURNS)
    expect(job.maxBudgetUsd).toBe(SCOUT_MAX_BUDGET_USD)
    expect(job.allowedTools).toEqual(["WebSearch", "WebFetch"])
  })

  it("keeps only items with an http(s) URL, at most ten, cleaned; anything else is no answer", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `T${i}`,
      interest: "x",
      why: "y",
      url: `https://e.com/${i}`,
    }))
    expect(parseScout({ items: many })?.items).toHaveLength(10)
    const parsed = parseScout({
      items: [
        { title: "Bad", interest: "x", why: "y", url: "javascript:alert(1)" },
        {
          title: "@everyone look",
          interest: "x",
          why: "[click](https://evil.example)",
          url: "https://ok.example/a",
        },
      ],
    })
    expect(parsed?.items.map((i) => i.url)).toEqual(["https://ok.example/a"])
    expect(parsed?.items[0]?.title).not.toBe("@everyone look")
    expect(parsed?.items[0]?.why).toContain("] (")
    expect(parseScout({ nope: true })).toBeNull()
    expect(itemKey("https://example.org/kataba#top")).toBe(itemKey("https://example.org/kataba"))
  })

  it("says when there is nothing new, and when everything was shown before", () => {
    expect(renderScout("Scout for Anne", [], "", 0)).toContain("Nothing new this time.")
    expect(renderScout("Scout for Anne", [], "", 2)).toContain(
      "everything it found was shown before",
    )
    expect(
      scoutState({
        shown: Array.from({ length: MAX_SHOWN + 5 }, (_, i) => ({ k: `${i}`, t: "t" })),
      }).shown,
    ).toHaveLength(MAX_SHOWN)
  })
})
