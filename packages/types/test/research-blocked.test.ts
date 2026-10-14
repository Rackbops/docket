import {
  createTask,
  type Executor,
  FOLLOW_UP_PREFIX,
  type JobResult,
  type JobSpec,
  Lanes,
  MemoryStore,
  reschedule,
} from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"

import {
  ANSWER_SCHEMA,
  type GatheredPage,
  MAX_BLOCKED,
  MAX_MESSAGE_CHARS,
  parseAnswer,
  type ReadSources,
  type ResearchConfig,
  renderAnswer,
  researchJob,
  researchState,
  researchType,
  reviewJob,
  SENT_DISALLOWED_TOOLS,
  SOURCES_DEADLINE_MARGIN_MS,
  SOURCES_WAIT_MS,
  sourcesExpiry,
  TASK_TYPES,
} from "../src/index.js"
import { actor, FakeClock, FakeNotifier, T0 } from "./helpers.js"

const BGG = "https://boardgamegeek.com/browse/boardgame?sort=rank&year=2026"
const HOUR = 3_600_000

const DRAFT = {
  summary: "Several 2026 strategy games are well reviewed; the BGG rankings could not be read.",
  findings: [
    { claim: "Example Game won a 2026 design award.", sources: ["https://example.org/award"] },
  ],
  uncertain: ["Which game is highest rated on BoardGameGeek."],
}
const BLOCKED = [{ site: "boardgamegeek.com", url: BGG, why: "403 Forbidden" }]
const BLOCKED_DRAFT = { ...DRAFT, blocked: BLOCKED }

const UPDATE = {
  summary: "The BGG ranking puts Example Game first.",
  findings: [
    // A claim the first answer made, word for word: neither shown nor saved again.
    DRAFT.findings[0],
    { claim: "Example Game is rated 8.4 on BoardGameGeek.", sources: [BGG] },
  ],
  uncertain: [],
}

const PAGES: GatheredPage[] = [
  { url: BGG, title: "Board game rank, 2026", text: "1. Example Game (2026), rated 8.4." },
]

function ok(structuredOutput: unknown, totalCostUsd = 0.3): JobResult {
  return { kind: "success", result: "done", structuredOutput, totalCostUsd, durationMs: 1000 }
}
const approve = (answer: unknown) => ok({ verdict: "approve", problems: [], answer }, 0.1)

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

const WEB: ResearchConfig = { question: "Which 2026 board game is highest rated?" }

async function setup(executor: Executor, readSources?: ReadSources, config: ResearchConfig = WEB) {
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
  return { store, clock, notifier, lanes, task, larry }
}

/** The host's `ready`, a minute on: delete the queued follow-up, then move the once task to now. */
async function ready(s: Awaited<ReturnType<typeof setup>>): Promise<void> {
  // The pages come in later than the first pass: a `once` at the same instant would be its run.
  s.clock.advance(60_000)
  const queued = await s.store.listOccurrences({ taskId: s.task.id, status: "queued" })
  for (const o of queued) {
    if (o.dedupeKey.startsWith(FOLLOW_UP_PREFIX)) await s.store.deleteOccurrence(o.id)
  }
  const task = await s.store.getTask(s.task.id)
  if (!task) throw new Error("no task")
  await reschedule(
    s.store,
    task,
    s.larry,
    { kind: "once", at: s.clock.now().toISOString() },
    s.larry.id,
    s.clock.now(),
  )
}

describe("blocked pages in an answer", () => {
  it("parseAnswer keeps at most six, cleaned, each url through safeUrl", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      site: ` site${i}.example\n`,
      url: i === 0 ? "javascript:alert(1)" : `https://site${i}.example/`,
      why: "refused",
    }))
    const parsed = parseAnswer({ ...DRAFT, blocked: [{ why: "no site" }, ...many] })
    expect(parsed?.blocked).toHaveLength(MAX_BLOCKED)
    expect(parsed?.blocked?.[0]).toEqual({ site: "site0.example", why: "refused" })
    expect(parsed?.blocked?.[1]).toEqual({
      site: "site1.example",
      url: "https://site1.example/",
      why: "refused",
    })
    // No list, or an empty one: no key at all, so a draft without one is what it was.
    expect(parseAnswer(DRAFT)).not.toHaveProperty("blocked")
    expect(parseAnswer({ ...DRAFT, blocked: [] })).not.toHaveProperty("blocked")
    expect(parseAnswer({ ...DRAFT, blocked: "403" })).not.toHaveProperty("blocked")
  })

  it("is in the schema as optional, asked for in the prompt, and never rendered", () => {
    expect(Object.keys(ANSWER_SCHEMA.properties)).toContain("blocked")
    expect(ANSWER_SCHEMA.required).not.toContain("blocked")
    expect(researchJob(WEB).prompt).toContain("list it in `blocked`")
    const parsed = parseAnswer(BLOCKED_DRAFT)
    if (!parsed) throw new Error("no answer")
    const text = renderAnswer("t", parsed, { verdict: "approve", problems: [], answer: parsed })
    expect(text).not.toContain("403 Forbidden")
  })

  it("sourcesExpiry: 14 days out, or 10 minutes before a sooner deadline, never before now", () => {
    const now = new Date(T0)
    expect(sourcesExpiry(now, null)).toEqual({
      at: new Date(now.getTime() + SOURCES_WAIT_MS),
      byDeadline: false,
    })
    const soon = new Date(now.getTime() + 2 * HOUR)
    expect(sourcesExpiry(now, soon)).toEqual({
      at: new Date(soon.getTime() - SOURCES_DEADLINE_MARGIN_MS),
      byDeadline: true,
    })
    expect(sourcesExpiry(now, new Date(now.getTime() + 60_000))).toEqual({
      at: now,
      byDeadline: true,
    })
  })
})

describe("a first pass that could not open a page", () => {
  it("sends one DM, saves the findings and queues a follow-up at the expiry", async () => {
    const { executor, specs } = scripted(ok(BLOCKED_DRAFT), approve(DRAFT))
    const s = await setup(executor, async () => [])
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    expect(specs).toHaveLength(2)
    expect(s.notifier.sent).toHaveLength(1)
    const text = s.notifier.sent[0]?.message.text ?? ""
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(text).toContain(DRAFT.summary)
    expect(text).toContain("Couldn't open:")
    expect(text).toContain(`- boardgamegeek.com: 403 Forbidden <${BGG}>`)
    expect(text).toContain(`ask Claude in Chrome to gather pages for this request (${s.task.id})`)
    const until = new Date(new Date(T0).getTime() + SOURCES_WAIT_MS).toISOString()
    expect(text).toContain(`any time before ${until}`)
    const task = await s.store.getTask(s.task.id)
    expect(task?.status).toBe("active")
    const state = researchState(task?.state)
    expect(state).toMatchObject({ phase: "awaiting-pages", pass: 1, blocked: BLOCKED })
    expect(state.earlier).toEqual(DRAFT)
    const queued = await s.store.listOccurrences({ taskId: s.task.id, status: "queued" })
    expect(queued.map((o) => o.dueAt)).toEqual([until])
    const findings = await s.store.listFindings({ taskId: s.task.id })
    expect(findings.map((f) => f.tags)).toEqual([["research", "approve"]])
  })

  it("keeps the DM inside the cap with a long answer and a full blocked list", async () => {
    const long = {
      summary: "s".repeat(1200),
      findings: Array.from({ length: 12 }, (_, i) => ({
        claim: `${"c".repeat(380)} ${i}`,
        sources: [`https://example.org/${i}`],
      })),
      uncertain: Array.from({ length: 6 }, () => "u".repeat(300)),
      blocked: Array.from({ length: 6 }, (_, i) => ({
        site: "b".repeat(100),
        url: `https://blocked${i}.example/${"p".repeat(300)}`,
        why: "w".repeat(200),
      })),
    }
    const { executor } = scripted(ok(long), approve(long))
    const s = await setup(executor, async () => [])
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    const text = s.notifier.sent[0]?.message.text ?? ""
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(text).toContain("A fuller pass is queued")
  })

  it("behaves as before 0.9.0 without a store to read pages from", async () => {
    const { executor } = scripted(ok(BLOCKED_DRAFT), approve(DRAFT))
    const s = await setup(executor)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    const text = s.notifier.sent[0]?.message.text ?? ""
    expect(text).not.toContain("Couldn't open")
    expect((await s.store.getTask(s.task.id))?.status).toBe("done")
    expect(await s.store.listOccurrences({ taskId: s.task.id, status: "queued" })).toEqual([])
  })

  it("does not wait when the deadline leaves no room", async () => {
    const { executor } = scripted(ok(BLOCKED_DRAFT), approve(DRAFT))
    const deadline = new Date(new Date(T0).getTime() + 5 * 60_000).toISOString()
    const s = await setup(executor, async () => [], { ...WEB, deadline })
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    expect(s.notifier.sent[0]?.message.text).not.toContain("Couldn't open")
    expect((await s.store.getTask(s.task.id))?.status).toBe("done")
  })

  it("takes the research run's list, not the reviewer's", async () => {
    const { executor } = scripted(ok(DRAFT), approve(BLOCKED_DRAFT))
    const s = await setup(executor, async () => [])
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    expect((await s.store.getTask(s.task.id))?.status).toBe("done")
  })

  it("sends nothing and runs nothing while it waits", async () => {
    const { executor, specs } = scripted(ok(BLOCKED_DRAFT), approve(DRAFT))
    let reads = 0
    const s = await setup(executor, async () => {
      reads++
      return PAGES
    })
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    for (let i = 0; i < 50; i++) {
      s.clock.advance(6 * HOUR)
      await s.lanes.tickNotify()
      await s.lanes.tickExecute()
    }
    expect(specs).toHaveLength(2)
    expect(s.notifier.sent).toHaveLength(1)
    expect(reads).toBe(0)
    expect(researchState((await s.store.getTask(s.task.id))?.state).phase).toBe("awaiting-pages")
    expect(await s.store.listUsage()).toHaveLength(2)
  })
})

describe("the second pass", () => {
  it("researches the gathered pages on the earlier answer, then reviews them", async () => {
    const { executor, specs } = scripted(
      ok(BLOCKED_DRAFT),
      approve(DRAFT),
      ok(UPDATE),
      approve(UPDATE),
    )
    const s = await setup(executor, async () => PAGES)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    s.clock.advance(HOUR)
    await ready(s)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    expect(specs).toHaveLength(4)
    const [, , second, check] = specs
    expect(second?.prompt).toContain("<<<EARLIER")
    expect(second?.prompt).toContain("Board game rank, 2026")
    expect(second?.prompt).toContain("Correction:")
    expect(second?.disallowedTools).toEqual(expect.arrayContaining(SENT_DISALLOWED_TOOLS))
    expect(check?.prompt).toContain("Board game rank, 2026")
    expect(check?.disallowedTools).toEqual(expect.arrayContaining(SENT_DISALLOWED_TOOLS))
    expect(s.notifier.sent).toHaveLength(2)
    const update = s.notifier.sent[1]?.message.text ?? ""
    expect(update).toContain("Update to Best of 2026:")
    expect(update).toContain("Example Game is rated 8.4 on BoardGameGeek.")
    expect(update).not.toContain(DRAFT.findings[0]?.claim)
    const findings = await s.store.listFindings({ taskId: s.task.id })
    expect(findings.map((f) => f.tags)).toEqual([
      ["research", "approve"],
      ["research", "approve", "update"],
    ])
    expect((await s.store.getTask(s.task.id))?.status).toBe("done")
    // ready removed the wait's own run: nothing is left to fire at the expiry.
    expect(await s.store.listOccurrences({ taskId: s.task.id, status: "queued" })).toEqual([])
  })

  it("says so in one line when the pages add nothing", async () => {
    const nothing = { summary: "Nothing changed.", findings: [], uncertain: [] }
    const { executor } = scripted(ok(BLOCKED_DRAFT), approve(DRAFT), ok(nothing), approve(nothing))
    const s = await setup(executor, async () => PAGES)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    await ready(s)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    expect(s.notifier.sent[1]?.message.text).toBe(
      "Update to Best of 2026: the pages added nothing new, so the first answer stands.",
    )
  })

  it("says the update could not be checked when its reviewer rejects it", async () => {
    const rejected = ok({ verdict: "reject", problems: ["unsupported"] })
    const { executor } = scripted(ok(BLOCKED_DRAFT), approve(DRAFT), ok(UPDATE), rejected)
    const s = await setup(executor, async () => PAGES)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    await ready(s)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    expect(s.notifier.sent[1]?.message.text).toBe(
      `Research ${s.task.id}: the update could not be checked, so the first answer stands.`,
    )
    expect(await s.store.listFindings({ taskId: s.task.id })).toHaveLength(1)
    expect((await s.store.getTask(s.task.id))?.status).toBe("done")
  })

  it("ends quietly and uncharged at the expiry when no page came in", async () => {
    const { executor, specs } = scripted(ok(BLOCKED_DRAFT), approve(DRAFT))
    const s = await setup(executor, async () => [])
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    s.clock.advance(SOURCES_WAIT_MS)
    await s.lanes.tickExecute()
    expect(specs).toHaveLength(2)
    expect(s.notifier.sent).toHaveLength(2)
    expect(s.notifier.sent[1]?.message.text).toBe(
      `Research ${s.task.id}: no pages came in, so the first answer stands.`,
    )
    expect(await s.store.listUsage()).toHaveLength(2)
    expect((await s.store.getTask(s.task.id))?.status).toBe("done")
  })

  it("ends quietly and uncharged past the deadline", async () => {
    const { executor, specs } = scripted(ok(BLOCKED_DRAFT), approve(DRAFT))
    const deadline = new Date(new Date(T0).getTime() + 3 * HOUR).toISOString()
    let reads = 0
    const s = await setup(
      executor,
      async () => {
        reads++
        return PAGES
      },
      { ...WEB, deadline },
    )
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    s.clock.advance(4 * HOUR)
    await ready(s)
    await s.lanes.tickExecute()
    expect(specs).toHaveLength(2)
    expect(reads).toBe(0)
    expect(s.notifier.sent[1]?.message.text).toContain("the deadline passed before the pages")
    expect(await s.store.listUsage()).toHaveLength(2)
    expect((await s.store.getTask(s.task.id))?.status).toBe("done")
  })

  it("keeps the pass through a retried failure, and ends in one line on a second", async () => {
    const timeout: JobResult = { kind: "timeout", detail: "slow", durationMs: 1 }
    const { executor, specs } = scripted(
      ok(BLOCKED_DRAFT),
      approve(DRAFT),
      ok(UPDATE),
      timeout,
      timeout,
    )
    const s = await setup(executor, async () => PAGES)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    await ready(s)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    expect(researchState((await s.store.getTask(s.task.id))?.state)).toMatchObject({
      phase: "review",
      pass: 2,
      failures: 1,
    })
    await s.lanes.tickExecute()
    expect(specs).toHaveLength(5)
    expect(s.notifier.sent[1]?.message.text).toBe(
      `Research ${s.task.id}: the fuller pass could not finish (it took too long), so the first ` +
        "answer stands.",
    )
  })
})

describe("research state", () => {
  it("reads a state stored before 0.9.0 as it did", () => {
    expect(researchState({ phase: "review", failures: 1, draft: DRAFT })).toEqual({
      phase: "review",
      failures: 1,
      draft: DRAFT,
    })
    expect(researchState({ phase: "research", failures: 1, draft: null })).toEqual({
      phase: "research",
      failures: 1,
      draft: null,
    })
    expect(researchState({ phase: "done", failures: 0, draft: DRAFT })).toEqual({
      phase: "done",
      failures: 0,
      draft: DRAFT,
    })
  })

  it("keeps the second-pass fields, and a wait with nothing to build on is done", () => {
    const waiting = {
      phase: "awaiting-pages",
      failures: 0,
      draft: BLOCKED_DRAFT,
      pass: 1,
      blocked: BLOCKED,
      earlier: DRAFT,
    }
    expect(researchState(waiting)).toEqual(waiting)
    expect(researchState({ ...waiting, earlier: null }).phase).toBe("done")
    expect(researchState({ ...waiting, phase: "review", pass: 2, draft: UPDATE })).toMatchObject({
      phase: "review",
      pass: 2,
      earlier: DRAFT,
    })
  })

  it("web prompts are unchanged when nothing is blocked, but for the one new sentence", () => {
    const prompt = researchJob(WEB).prompt
    const sentence =
      "\nIf a page you needed would not open (refused, a 403, a CAPTCHA, a sign-in wall), list " +
      "it in `blocked` with its site, its URL if you have one, and why."
    expect(prompt.endsWith(sentence)).toBe(true)
    expect(prompt).not.toContain("<<<EARLIER")
    expect(reviewJob(WEB, DRAFT).prompt).not.toContain("blocked")
  })
})

describe("the depth chain", () => {
  it("research, review, wait, research, review completes without hitting the follow-up cap", async () => {
    const { executor, specs } = scripted(
      ok(BLOCKED_DRAFT),
      approve(DRAFT),
      ok(UPDATE),
      approve(UPDATE),
    )
    const s = await setup(executor, async () => PAGES)
    await s.lanes.tickExecute()
    await s.lanes.tickExecute()
    for (let i = 0; i < 24; i++) {
      s.clock.advance(HOUR)
      await s.lanes.tickExecute()
    }
    await ready(s)
    for (let i = 0; i < 4; i++) {
      await s.lanes.tickExecute()
      await s.lanes.tickNotify()
    }
    expect(specs).toHaveLength(4)
    expect(s.notifier.sent.map((m) => m.message.text.split("\n")[0])).toEqual([
      "Research: Best of 2026",
      "Update to Best of 2026:",
    ])
    // The follow-up cap's own notice would be a third DM.
    expect((await s.store.getTask(s.task.id))?.status).toBe("done")
  })
})
