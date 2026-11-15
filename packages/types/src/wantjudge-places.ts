import {
  clean,
  ExecutorUnavailableError,
  type Finding,
  FOLLOW_UP_PREFIX,
  type JobResult,
  type JobSpec,
  type NoJob,
  type Outcome,
  type RunContext,
} from "@rackbops/docket-core"
import { retryOutcome } from "./retry.js"
import {
  type PlaceState,
  placeDue,
  placeKey,
  readPlaceStates,
  type WantPlace,
  wantPlaces,
} from "./want-places.js"
import { listingKey, type Source, type SourceId, SourceMiss } from "./want-sources.js"
import { keepPrices } from "./want-spike.js"
import { sourceText } from "./want-text.js"
import {
  buildJudgeJob,
  closedSource,
  FIT_SAID,
  type Fit,
  type HeldItem,
  type JudgeItem,
  type JudgeState,
  type JudgeVerdict,
  judgeHosts,
  judgeState,
  type PlacedListing,
  parseVerdicts,
  RETRY_GRACE_MS,
  readHeld,
  renderJudged,
  renderUnchecked,
  SAID,
} from "./wantjudge.js"
import {
  clip,
  keepsFindings,
  listingFinding,
  MAX_NEW_PER_RUN,
  MAX_REPORTED,
  miss,
  missReason,
  missText,
  type Polled,
  placeConfig,
  priceText,
  type WantConfig,
  type WantState,
  wanted,
  wantState,
} from "./wantlist.js"

/**
 * The judged watch of several places (Rod, 2026-11-15: "start it right after 59", on the model
 * checking a watch that looks in several places). It runs as the one-place judged watch does --
 * a scheduled run reads, a follow-up asks the model, `finish` maps the verdicts back -- with the
 * read and the look spread over every place:
 *
 * - The read is the plain watch's several-place read (wantlist.ts `runPlaces`): each place due a
 *   look is read as a one-place watch (`pollWant`), each keeps its own misses and last look
 *   (`places`), a listing two places list under the same id is taken once, and at most
 *   `MAX_NEW_PER_RUN` are taken in all. A place's warning that it read nothing goes out at once,
 *   on its own; the listings go out after the model's look.
 * - What it found waits in the state with its place's key: an eBay API place's listings as eBay's
 *   item numbers only (`held`, no eBay data kept), the rest as listings (`pending`).
 * - The model gets them all in one Job, numbered pending first, then held (read back from eBay in
 *   full, as the one-place eBay watch does), each priced by its own place. It may open listings
 *   only on the open places' own hosts (`judgeHosts` per place), none when every place is closed.
 * - Its answer is told in one DM, each listing by its own place; a listing the model saw nothing
 *   of is remembered as the one-place watch would (pending shown as "maybe", held let go
 *   unremembered); eBay listings keep no findings or prices.
 *
 * A one-place judged watch never comes here (wantjudge.ts), so its behaviour is unchanged.
 */

/** A pending listing's place: its key's place, or the watch's first when the key is unknown. */
function configFor(
  config: WantConfig,
  places: readonly WantPlace[],
  key: string | undefined,
): WantConfig {
  const place = places.find((p) => placeKey(p) === key) ?? (places[0] as WantPlace)
  return placeConfig(config, place)
}

/**
 * A held listing's place: always an eBay one, whatever its key says, so an eBay listing is never
 * kept as a finding or a price -- its key's place, else the watch's first eBay place, else an eBay
 * place of the watch's limits (a place edited away while it waited).
 */
function heldConfig(
  config: WantConfig,
  places: readonly WantPlace[],
  key: string | undefined,
): WantConfig {
  const ebay = places.filter((p) => p.source === "ebay")
  const place = ebay.find((p) => placeKey(p) === key) ?? ebay[0]
  if (place) return placeConfig(config, place)
  return placeConfig(config, { source: "ebay", target: config.target })
}

/** The state with the places' own misses and looks, which `judgeState` does not carry. */
function withPlaces(state: JudgeState, places: Record<string, PlaceState>): JudgeState {
  const { places: _old, ...rest } = state as JudgeState & { places?: unknown }
  return Object.keys(places).length > 0 ? ({ ...rest, places } as JudgeState) : rest
}

/** One listing of the look: its number in the Job, the listing, its place's config, and whether eBay holds it. */
interface Entry extends JudgeItem {
  config: WantConfig
  /** A held eBay listing's key; absent for a pending one. */
  held?: string
}

/** What the model may open, and where the listings came from, over every place with a listing in the look. */
function reachOf(entries: readonly Entry[], places: readonly WantPlace[], config: WantConfig) {
  const configs = places.map((p) => placeConfig(config, p))
  const used = configs.filter((c) =>
    entries.some((e) => e.config.source === c.source && e.config.target === c.target),
  )
  const from = used.length > 0 ? used : configs
  const where = [...new Set(from.map((c) => sourceText(c.source).judgeWhere))]
  const hosts = new Set<string>()
  for (const c of from)
    for (const h of judgeHosts(
      entries
        .filter((e) => e.config.target === c.target && e.config.source === c.source)
        .map((e) => e.l),
      c,
    ))
      hosts.add(h)
  return {
    closed: from.every(closedSource),
    where:
      where.length === 1
        ? (where[0] as string)
        : `${where.slice(0, -1).join(", ")} and ${where[where.length - 1]}`,
    hosts: [...hosts],
  }
}

/**
 * The listings of the look, numbered as the Job numbers them: pending 1..P, held P+1..P+H by their
 * place in `held` (one not read back keeps its number, unused). A held read eBay refused just now
 * (`SourceMiss`) leaves every held listing out, `down`; one eBay will never read is in `dropped`.
 */
async function entriesOf(
  ctx: RunContext<WantConfig>,
  state: JudgeState,
  ebay: Source | undefined,
): Promise<{ entries: Entry[]; dropped: Set<string>; down: boolean }> {
  const places = wantPlaces(ctx.config)
  const entries: Entry[] = state.pending.map((l, i) => ({
    n: i + 1,
    l,
    config: configFor(ctx.config, places, l.place),
  }))
  if (state.held.length === 0) return { entries, dropped: new Set(), down: false }
  try {
    const { items, dropped } = await readHeld(ebay, state.held)
    for (const x of items) {
      const h = state.held[x.n - 1] as HeldItem
      entries.push({
        ...x,
        n: state.pending.length + x.n,
        config: heldConfig(ctx.config, places, h.place),
        held: h.id,
      })
    }
    return { entries, dropped, down: false }
  } catch (err) {
    if (!(err instanceof SourceMiss)) throw err
    return { entries, dropped: new Set(), down: true }
  }
}

/**
 * The look's listings, settled: `remember` remembered (never told again), the rest let go so a
 * later read finds them again, the look's count reset. The places' own state is kept.
 */
function settle(
  ctx: RunContext<WantConfig>,
  state: JudgeState,
  remember: readonly string[],
  told: number,
  extra: Partial<WantState> = {},
  places: Record<string, PlaceState> = readPlaceStates(ctx.state),
): JudgeState {
  const { retryAt: _done, ...rest } = state
  return withPlaces(
    {
      ...rest,
      ...extra,
      reported: [...state.reported, ...[...new Set(remember)].map(listingKey)].slice(-MAX_REPORTED),
      told: state.told + told,
      pending: [],
      held: [],
      failures: 0,
    },
    places,
  )
}

/**
 * eBay could not read its held listings back just now: a miss for each eBay place, told once at
 * `MISSES_BEFORE_TELLING` in a row (the one-place watch's rule, through `miss`). The listings are
 * let go, not held: a watch of several places keeps reading its other places, and the next read
 * of eBay finds them again.
 */
function heldDown(
  ctx: RunContext<WantConfig>,
  state: JudgeState,
): { extra: Partial<WantState>; places: Record<string, PlaceState>; warning?: string } {
  const places = readPlaceStates(ctx.state)
  let extra: Partial<WantState> = {}
  const warnings: string[] = []
  for (const [i, p] of wantPlaces(ctx.config).entries()) {
    if (!holding(state, p)) continue
    const key = placeKey(p)
    const config = placeConfig(ctx.config, p)
    const own =
      i === 0
        ? { misses: state.misses, warned: state.warned }
        : { misses: places[key]?.misses ?? 0, warned: places[key]?.warned === true }
    const st = { ...state, ...own }
    const out = miss(
      { ...ctx, config, state: st },
      st,
      new SourceMiss("eBay could not read its listings back just now"),
    )
    const s = wantState(out.state)
    if (i === 0) extra = { misses: s.misses, warned: s.warned }
    else places[key] = { ...places[key], misses: s.misses, warned: s.warned }
    if (out.notify) warnings.push(heldMissText(config, s.misses))
  }
  return { extra, places, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) }
}

/** eBay's search worked but its listings could not be read back: said so, naming the search. */
function heldMissText(config: WantConfig, misses: number): string {
  const times = misses === 1 ? "just now" : `${misses} times in a row`
  return `eBay found new listings for "${config.target}" but could not read them back ${times}.`
}

/** A place's miss, naming its search when another place reads the same source. */
function placeMissText(
  ctx: RunContext<WantConfig>,
  config: WantConfig,
  misses: number,
  reason: string,
): string {
  const text = missText(config, misses, reason)
  const twins = wantPlaces(ctx.config).filter((p) => p.source === config.source).length
  return twins > 1 ? `${text.slice(0, -1)}, searching for "${config.target}".` : text
}

/** Whether `place` is an eBay place with a listing held: by its key, or any eBay place for an untagged one. */
function holding(state: JudgeState, place: WantPlace): boolean {
  if (place.source !== "ebay") return false
  const key = placeKey(place)
  return state.held.some((h) => h.place === undefined || h.place === key)
}

/** eBay read its held listings back: the misses of each eBay place they came from are over, as after any good read. */
function heldUp(
  ctx: RunContext<WantConfig>,
  state: JudgeState,
): { extra: Partial<WantState>; places: Record<string, PlaceState> } {
  const places = readPlaceStates(ctx.state)
  let extra: Partial<WantState> = {}
  for (const [i, p] of wantPlaces(ctx.config).entries()) {
    if (!holding(state, p)) continue
    if (i === 0) extra = { misses: 0, warned: false }
    else {
      const key = placeKey(p)
      places[key] = { ...places[key], misses: 0, warned: false }
    }
  }
  return { extra, places }
}

/** `text` with `warning` before its last line (the Done line); the warning alone when there is no text. */
function withWarning(
  title: string,
  text: string | null,
  warning: string | undefined,
): string | null {
  if (warning === undefined) return text
  if (text === null) return clip(`${title}: ${warning} I keep looking; press Done to stop.`)
  const lines = text.split("\n")
  const last = lines.pop() ?? ""
  return [...lines, `${warning} I keep looking there.`, last].join("\n")
}

/**
 * The ids a look ends by remembering, as the one-place watch: every pending listing told or passed
 * over, and every held one but those eBay will never read, those it could not read just now, and
 * `unseen` (no verdict: judged afresh next time). One the limits as they are now leave out
 * (`unwanted`) is not remembered, so it comes back once it is within them again. A held listing
 * eBay says is gone (sold or ended) is remembered.
 */
function remembered(
  state: JudgeState,
  dropped: ReadonlySet<string>,
  down: boolean,
  unseen: ReadonlySet<string>,
  unwanted: ReadonlySet<string>,
): string[] {
  return [
    ...state.pending.filter((l) => !unwanted.has(l.id)).map((l) => l.id),
    ...(down
      ? []
      : state.held
          .map((h) => h.id)
          .filter((id) => !dropped.has(id) && !unseen.has(id) && !unwanted.has(id))),
  ]
}

/** The scheduled read over every place due a look: listings to judge, and any place's warning. */
async function readPlaces(
  ctx: RunContext<WantConfig>,
  state: JudgeState,
  look: (ctx: RunContext<WantConfig>, state: WantState) => Promise<Polled>,
): Promise<Outcome> {
  const places = wantPlaces(ctx.config)
  const before = readPlaceStates(ctx.state)
  const after: Record<string, PlaceState> = {}
  let shared: WantState = state
  let firstMiss = { misses: state.misses, warned: state.warned }
  const pending: PlacedListing[] = []
  const held: HeldItem[] = []
  const unread: string[] = []
  const seen = new Set<string>()
  const warnings: string[] = []
  const summaries: string[] = []
  const findings: Finding[] = []
  for (const [i, place] of places.entries()) {
    const key = placeKey(place)
    const own = before[key]
    const label = sourceText(place.source).where ?? place.target
    if (!placeDue(place, own, ctx.now)) {
      if (own) after[key] = own
      summaries.push(`${label}: not due`)
      continue
    }
    const config = placeConfig(ctx.config, place)
    const mine = i === 0 ? firstMiss : { misses: own?.misses ?? 0, warned: own?.warned === true }
    const st: WantState = { ...shared, ...mine }
    const placeCtx = { ...ctx, config, state: st }
    let polled: Polled
    try {
      polled = await look(placeCtx, st)
    } catch (err) {
      if (err instanceof ExecutorUnavailableError) {
        // BoardGameGeek busy twice: as the one-place watch, no miss; that place tries next look.
        if (own && i > 0) after[key] = own
        summaries.push(`${label}: busy; the next look tries again`)
        continue
      }
      polled = { kind: "done", outcome: miss(placeCtx, st, err) }
    }
    const outcome = polled.kind === "done" ? polled.outcome : null
    const next =
      outcome !== null
        ? { ...st, ...(outcome.state as WantState | undefined) }
        : polled.kind === "fresh"
          ? polled.state
          : st
    shared = { ...shared, reported: next.reported }
    const left = { misses: next.misses, warned: next.warned }
    if (i === 0) firstMiss = left
    else after[key] = { ...left, lastAt: ctx.now.toISOString() }
    if (outcome) {
      if (outcome.notify)
        warnings.push(placeMissText(ctx, config, next.misses, missReason(outcome)))
      if (outcome.findings) findings.push(...outcome.findings)
      summaries.push(`${label}: ${outcome.summary ?? ""}`)
      continue
    }
    if (polled.kind !== "fresh") continue
    findings.push(...polled.findings)
    summaries.push(`${label}: ${polled.summary}`)
    for (const l of polled.fresh) {
      const k = listingKey(l.id)
      if (seen.has(k) || pending.length + held.length >= MAX_NEW_PER_RUN) continue
      seen.add(k)
      if (config.source !== "ebay") pending.push({ ...l, place: key })
      // An eBay place keeps item numbers only; one with no item id is remembered unjudged and untold.
      else if (l.ref) held.push({ id: l.id, ref: l.ref, place: key })
      else unread.push(k)
    }
    // An eBay place's look is good only once its listings read back (`heldUp`): one whose search
    // put listings in `held` keeps its misses so far, so a host that cannot read them back is told.
    if (held.some((h) => h.place === key)) {
      if (i === 0) firstMiss = mine
      else after[key] = { ...mine, lastAt: ctx.now.toISOString() }
    }
  }
  const { retryAt: _none, ...rest } = state
  const next = withPlaces(
    {
      ...rest,
      ...shared,
      ...firstMiss,
      reported: [...shared.reported, ...unread].slice(-MAX_REPORTED),
      pending,
      held,
      failures: 0,
    },
    after,
  )
  const waiting = pending.length + held.length
  const summary = `${summaries.join("; ")}${waiting > 0 ? `; checking ${waiting}` : ""}`
  const text =
    warnings.length === 0
      ? null
      : clip(
          warnings.length === 1
            ? `${ctx.task.title}: ${warnings[0]} I keep looking; press Done to stop.`
            : [`${ctx.task.title}:`, ...warnings, "I keep looking; press Done to stop."].join("\n"),
        )
  return {
    state: next,
    summary,
    ...(waiting > 0 ? { followUp: {} } : {}),
    ...(text !== null ? { notify: { text, actions: ["done"] } } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  }
}

/** A several-place judged watch's `prepare`: the look's Job when listings wait, else the read. */
export async function preparePlaces(
  ctx: RunContext<WantConfig>,
  sources: Partial<Record<SourceId, Source>>,
  look: (ctx: RunContext<WantConfig>, state: WantState) => Promise<Polled>,
): Promise<JobSpec | NoJob> {
  const state = judgeState(ctx.state)
  const followUp = ctx.occurrence.dedupeKey.startsWith(FOLLOW_UP_PREFIX)
  if (state.pending.length > 0 || state.held.length > 0) {
    // As the one-place watch: a waiting retry keeps to its own follow-up unless long overdue.
    const overdue =
      state.retryAt !== undefined && ctx.now.getTime() > Date.parse(state.retryAt) + RETRY_GRACE_MS
    if (state.failures > 0 && !followUp && !overdue)
      return { outcome: { summary: "a retry of the last look is waiting" } }
    const { entries, dropped, down } = await entriesOf(ctx, state, sources.ebay)
    if (entries.length === 0) {
      if (down) {
        const d = heldDown(ctx, state)
        const text = withWarning(ctx.task.title, null, d.warning)
        return {
          outcome: {
            state: settle(ctx, state, [], 0, d.extra, d.places),
            summary: `nothing to check: eBay could not be read just now; its ${state.held.length} new listing(s) are let go for the next read of eBay to find again`,
            ...(text !== null ? { notify: { text, actions: ["done"] } } : {}),
          },
        }
      }
      const gone = state.held.filter((h) => !dropped.has(h.id)).map((h) => h.id)
      const up = heldUp(ctx, state)
      return {
        outcome: {
          state: settle(ctx, state, gone, 0, up.extra, up.places),
          summary: `nothing to check: the ${state.held.length} new listing(s) are gone from eBay or could not be read`,
        },
      }
    }
    return buildJudgeJob(
      ctx.task.title,
      ctx.config,
      entries,
      reachOf(entries, wantPlaces(ctx.config), ctx.config),
      (x) => (x as Entry).config,
    )
  }
  if (followUp) return { outcome: { summary: "nothing was waiting to be checked" } }
  return { outcome: await readPlaces(ctx, state, look) }
}

/** The look failed: retried as the one-place watch's, then its listings sent unchecked. */
function failed(
  ctx: RunContext<WantConfig>,
  state: JudgeState,
  entries: readonly Entry[],
  forget: { dropped: Set<string>; down: boolean },
  kind: Parameters<typeof retryOutcome>[0],
  detail: string,
): Outcome {
  const failures = state.failures + 1
  // The runner's detail can quote a listing; with an eBay place it is left out (no eBay data kept).
  const keepsAll =
    state.held.length === 0 &&
    wantPlaces(ctx.config).every((p) => keepsFindings(placeConfig(ctx.config, p)))
  const summary =
    keepsAll || kind === "malformed"
      ? clean(`judge ${kind} (try ${failures}): ${detail}`, 300, true)
      : `judge ${kind} (try ${failures})`
  const retry = retryOutcome(kind, failures, ctx.now)
  if (retry)
    return {
      state: withPlaces({ ...state, failures, retryAt: retry.at }, readPlaceStates(ctx.state)),
      followUp: retry.followUp,
      summary,
    }
  const within = entries.filter((e) => wanted(e.l, e.config))
  const unwanted = new Set(entries.filter((e) => !wanted(e.l, e.config)).map((e) => e.l.id))
  const byId = new Map(within.map((e) => [e.l.id, e.config]))
  const reason = SAID[kind] ?? "the check failed"
  const kept = within.filter((e) => keepsFindings(e.config))
  const d = forget.down ? heldDown(ctx, state) : { ...heldUp(ctx, state), warning: undefined }
  const text = withWarning(
    ctx.task.title,
    within.length > 0
      ? renderUnchecked(
          ctx.task.title,
          ctx.task.id,
          within.map((e) => e.l),
          reason,
          ctx.config,
          (l) => byId.get(l.id) ?? ctx.config,
        )
      : null,
    d.warning,
  )
  return {
    state: settle(
      ctx,
      state,
      remembered(state, forget.dropped, forget.down, new Set(), unwanted),
      within.length,
      d.extra,
      d.places,
    ),
    ...(text !== null ? { notify: { text, actions: ["done"] as const } } : {}),
    ...(kept.length > 0
      ? {
          findings: kept.map((e) =>
            listingFinding(e.l, e.config, priceText(e.l, e.config), ["unchecked"]),
          ),
        }
      : {}),
    summary: `${summary}; ${within.length} sent unchecked`,
  }
}

/** A several-place judged watch's `finish`: the verdicts mapped onto every place's listings, one DM. */
export async function finishPlaces(
  ctx: RunContext<WantConfig>,
  result: JobResult,
  sources: Partial<Record<SourceId, Source>>,
): Promise<Outcome> {
  const state = judgeState(ctx.state)
  if (state.pending.length === 0 && state.held.length === 0)
    return { summary: "nothing was waiting to be checked" }
  // Held eBay listings are read back again for the DM (a sold or ended one drops out).
  const { entries, dropped, down } = await entriesOf(ctx, state, sources.ebay)
  const forget = { dropped, down }
  if (result.kind !== "success")
    return failed(ctx, state, entries, forget, result.kind, result.detail)
  const count = state.pending.length + state.held.length
  const verdicts = parseVerdicts(result.structuredOutput, count)
  if (!verdicts)
    return failed(ctx, state, entries, forget, "malformed", "no verdicts in the structured output")
  // No verdict for any listing shown: malformed, retried, then sent unchecked, as the one-place watch.
  if (entries.length > 0 && !entries.some((e) => verdicts.has(e.n)))
    return failed(ctx, state, entries, forget, "malformed", "no verdict for any listing shown")
  // A pending listing with no verdict is shown as "maybe", as the one-place watch shows it; a held
  // one was most likely not in the prompt (unread at the look) and is judged afresh next time.
  const unseen = new Set(
    entries.filter((e) => e.held !== undefined && !verdicts.has(e.n)).map((e) => e.l.id),
  )
  const unwanted = new Set(entries.filter((e) => !wanted(e.l, e.config)).map((e) => e.l.id))
  const all = entries
    .filter((e) => !unseen.has(e.l.id) && !unwanted.has(e.l.id))
    .map((e) => ({
      e,
      v: verdicts.get(e.n) ?? ({ fit: "maybe", why: "", seller: "" } as JudgeVerdict),
    }))
  const rank: Record<Fit, number> = { match: 0, maybe: 1, no: 2 }
  const shown = all.filter((x) => x.v.fit !== "no").sort((a, b) => rank[a.v.fit] - rank[b.v.fit])
  const passed = all.length - shown.length
  const findings: Finding[] = all
    .filter(({ e }) => keepsFindings(e.config))
    .map(({ e, v }) =>
      listingFinding(
        e.l,
        e.config,
        `${priceText(e.l, e.config)} -- ${FIT_SAID[v.fit]}${v.why ? `: ${v.why}` : ""}`,
        [v.fit],
      ),
    )
  // The usual price learns only from listings found worth a look, never an eBay one (docket#144).
  const priced = shown.filter(({ e }) => keepsFindings(e.config)).map(({ e }) => e.l)
  const prices =
    priced.length > 0
      ? keepPrices(state.prices ?? [], priced, ctx.now, ctx.config.currency)
      : undefined
  // eBay could not read its held listings back for the DM: they are let go, and it is a miss.
  const d = down ? heldDown(ctx, state) : heldUp(ctx, state)
  const text = withWarning(
    ctx.task.title,
    shown.length > 0
      ? renderJudged(
          ctx.task.title,
          ctx.task.id,
          shown.map(({ e, v }) => ({ l: e.l, v, config: e.config })),
          passed,
          ctx.config,
        )
      : null,
    "warning" in d ? (d.warning as string | undefined) : undefined,
  )
  return {
    state: settle(
      ctx,
      state,
      remembered(state, dropped, down, unseen, unwanted),
      shown.length,
      { ...(prices !== undefined ? { prices } : {}), ...d.extra },
      d.places,
    ),
    ...(text !== null ? { notify: { text, actions: ["done"] } } : {}),
    ...(findings.length > 0 ? { findings } : {}),
    summary: `judged ${all.length}: ${shown.length} worth a look, ${passed} not it`,
  }
}
