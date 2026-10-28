import { createTask, type PollSchedule } from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"

import {
  MISSES_BEFORE_TELLING,
  type PriceConfig,
  type PriceState,
  price,
  reference,
} from "../src/index.js"
import { actor, FakeFetch, tracker } from "./helpers.js"

const URL = "https://shop.example/widget"
const HOUR = 3_600_000
const sixHourly: PollSchedule = {
  kind: "poll",
  every: 6,
  unit: "hour",
  start: "2026-03-02T12:00:00.000Z",
}

function page(amount: number, currency = "USD"): string {
  const ld = {
    "@type": "Product",
    name: "Widget",
    offers: { "@type": "Offer", price: amount, priceCurrency: currency },
  }
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`
}

async function tracked(config: Partial<PriceConfig> = {}, fetch = new FakeFetch()) {
  const t = await tracker(fetch)
  const { task } = await createTask(
    t.store,
    actor(t.owner),
    t.owner,
    { type: price, title: "widget", config: { url: URL, ...config }, schedule: sixHourly },
    t.clock.now(),
  )
  return { ...t, fetch, task }
}

/** Serves each price in turn, one poll each, and returns the DM texts sent. */
async function observe(
  t: Awaited<ReturnType<typeof tracked>>,
  prices: number[],
): Promise<string[]> {
  const before = t.notifier.sent.length
  for (const p of prices) {
    t.fetch.set(URL, page(p))
    await t.lanes.tickNotify()
    t.clock.advance(6 * HOUR)
  }
  return t.notifier.sent.slice(before).map((s) => s.message.text)
}

describe("price", () => {
  it("treats a 0 baseline kept from before 0.15.0 as no baseline (docket#40)", () => {
    const state = { first: 0, last: 0, peak: 0, below: false, misses: 0, alerts: 0 }
    expect(reference(state, "first")).toBeNull()
    expect(reference(state, "peak")).toBeNull()
    expect(reference({ ...state, first: 49.99 }, "first")).toBe(49.99)
  })

  it("takes a read of 0 as a miss, not a baseline, and baselines on the next real price (docket#40)", async () => {
    const t = await tracked({ baseline: "first" })
    const texts = await observe(t, [0, 0, 49.99, 44.99])
    expect(texts).toEqual([
      "Now tracking widget at 49.99 USD. I will say when it drops 10% or more from the first price seen. https://shop.example/widget",
      "widget: 44.99 USD, down 10% from 49.99 USD (first seen). https://shop.example/widget",
    ])
    expect(texts.join("\n")).not.toContain("NaN")
    expect((await t.store.listSeries(t.task.id)).map((p) => p.value)).toEqual([49.99, 44.99])
  })

  it("alerts exactly once per crossing of the drop line, with the delta", async () => {
    const t = await tracked({ baseline: "first" })
    const texts = await observe(t, [49.99, 47.99, 44.99, 44.99, 42, 46, 44])
    expect(texts).toEqual([
      "Now tracking widget at 49.99 USD. I will say when it drops 10% or more from the first price seen. https://shop.example/widget",
      "widget: 44.99 USD, down 10% from 49.99 USD (first seen). https://shop.example/widget",
      "widget: 44.00 USD, down 12% from 49.99 USD (first seen). https://shop.example/widget",
    ])
    expect((await t.store.listSeries(t.task.id)).map((p) => p.value)).toEqual([
      49.99, 47.99, 44.99, 44.99, 42, 46, 44,
    ])
    expect((await t.store.getTask(t.task.id))?.state).toMatchObject({
      first: 49.99,
      last: 44,
      peak: 49.99,
      below: true,
      alerts: 2,
    })
    const summaries = (await t.store.listOccurrences({ taskId: t.task.id })).map((o) => o.summary)
    expect(summaries[0]).toBe("baseline 49.99 USD")
    expect(summaries[2]).toBe("alert: 44.99 USD, down 10% from 49.99 USD")
    expect(summaries[7]).toBeNull() // the next poll, queued
  })

  it("measures from the last price by default, and from the peak when asked", async () => {
    const last = await tracked()
    expect((await observe(last, [100, 95, 89, 80, 80])).slice(1)).toEqual([
      "widget: 80.00 USD, down 10% from 89.00 USD (last seen). https://shop.example/widget",
    ])
    const peak = await tracked({ baseline: "peak", dropPercent: 10 })
    expect((await observe(peak, [100, 120, 110, 108, 107])).slice(1)).toEqual([
      "widget: 108.00 USD, down 10% from 120.00 USD (peak seen). https://shop.example/widget",
    ])
  })

  it("tells the owner once after three polls without a price, then keeps polling", async () => {
    const t = await tracked()
    for (let i = 0; i < MISSES_BEFORE_TELLING + 1; i++) {
      await t.lanes.tickNotify() // 404 every time
      t.clock.advance(6 * HOUR)
    }
    expect(t.notifier.sent.map((s) => s.message.text)).toEqual([
      "widget: no price read from https://shop.example/widget 3 polls in a row (HTTP 404). Check the page or the pattern; reply done to stop tracking.",
    ])
    expect((await t.store.getTask(t.task.id))?.state).toMatchObject({ misses: 4, first: null })
    expect(await observe(t, [20])).toHaveLength(1) // the page came back: the baseline DM
    expect((await t.store.getTask(t.task.id))?.state).toMatchObject({ misses: 0, first: 20 })
    const statuses = (await t.store.listOccurrences({ taskId: t.task.id })).map((o) => o.status)
    expect(statuses).toEqual(["done", "done", "done", "done", "done", "queued"])
  })

  it("reads the owner's pattern and currency when the page has no structured price", async () => {
    const fetch = new FakeFetch({ [URL]: "<div class=p>Now only &pound;12.50!</div>" })
    const t = await tracked({ pattern: "only &pound;([\\d.]+)", currency: "GBP" }, fetch)
    await t.lanes.tickNotify()
    expect(t.notifier.sent[0]?.message.text).toMatch(/^Now tracking widget at 12.50 GBP\./)
  })

  it("never fetches with a pattern that could stall the notify lane (docket#45)", async () => {
    const fetch = new FakeFetch({ [URL]: "a".repeat(40) })
    const t = await tracked({ pattern: "(a+)+b" }, fetch)
    for (let i = 0; i < MISSES_BEFORE_TELLING; i++) {
      await t.lanes.tickNotify()
      t.clock.advance(6 * HOUR)
    }
    expect(fetch.requests).toEqual([])
    expect(t.notifier.sent[0]?.message.text).toContain(
      "pattern refused: the pattern repeats a group",
    )
  })

  it("takes a read in another currency as a miss, never a drop (docket#59)", async () => {
    const t = await tracked()
    expect(await observe(t, [100])).toHaveLength(1) // the baseline, in USD
    t.fetch.set(URL, page(50, "EUR"))
    await t.lanes.tickNotify()
    t.clock.advance(6 * HOUR)
    expect(t.notifier.sent).toHaveLength(1)
    expect((await t.store.getTask(t.task.id))?.state).toMatchObject({
      currency: "USD",
      last: 100,
      misses: 1,
    })
    // Back in USD, a real drop still alerts.
    expect(await observe(t, [85])).toEqual([
      "widget: 85.00 USD, down 15% from 100.00 USD (last seen). https://shop.example/widget",
    ])
  })

  it("holds a state from before docket#59 to the config's currency, and ignores the fallback", async () => {
    // A stored state with no currency (written before the field existed), on a USD watch.
    const t = await tracked({ currency: "USD" })
    expect(await observe(t, [100])).toHaveLength(1)
    const stored = (await t.store.getTask(t.task.id))?.state as PriceState
    const { currency: _, ...legacy } = stored
    await t.store.updateTask(t.task.id, { state: legacy, at: t.clock.now().toISOString() })
    t.fetch.set(URL, page(50, "EUR"))
    await t.lanes.tickNotify()
    t.clock.advance(6 * HOUR)
    expect(t.notifier.sent).toHaveLength(1)
    expect((await t.store.getTask(t.task.id))?.state).toMatchObject({ last: 100, misses: 1 })

    // A EUR baseline, then a page that names no currency on a USD watch: the config's USD is
    // only a fallback for showing the price, so the read counts and a real drop alerts.
    const e = await tracked({ currency: "USD" })
    e.fetch.set(URL, page(100, "EUR"))
    await e.lanes.tickNotify()
    e.clock.advance(6 * HOUR)
    const bare = { "@type": "Product", offers: { "@type": "Offer", price: 80 } }
    e.fetch.set(URL, `<script type="application/ld+json">${JSON.stringify(bare)}</script>`)
    await e.lanes.tickNotify()
    expect((await e.store.getTask(e.task.id))?.state).toMatchObject({
      currency: "EUR",
      last: 80,
      misses: 0,
      alerts: 1,
    })
  })

  it("stops tracking on done", async () => {
    const t = await tracked()
    await observe(t, [10])
    const [first] = await t.store.listOccurrences({ taskId: t.task.id })
    const outcome = await t.lanes.reply({
      taskId: t.task.id,
      occurrenceId: first?.id ?? null,
      userId: t.owner.id,
      kind: "done",
      payload: null,
    })
    expect(outcome).toEqual({ complete: true, summary: "stopped tracking" })
    expect((await t.store.getTask(t.task.id))?.status).toBe("done")
    expect((await t.store.listOccurrences({ taskId: t.task.id })).map((o) => o.status)).toEqual([
      "done",
    ])
  })

  it("fails visibly, and keeps its schedule, when the host offers no Fetch port", async () => {
    const t = await tracker()
    const { task } = await createTask(
      t.store,
      actor(t.owner),
      t.owner,
      { type: price, title: "widget", config: { url: URL }, schedule: sixHourly },
      t.clock.now(),
    )
    expect(await t.lanes.tickNotify()).toMatchObject({ failed: 1 })
    const all = await t.store.listOccurrences({ taskId: task.id })
    expect(all[0]?.error).toMatch(/needs the Fetch port/)
    expect(all[1]?.status).toBe("queued")
  })
})
