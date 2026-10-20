# docket

Tracker core library: people, tasks, schedules, task types and ports. Two packages on public npm,
one version, one tag:

| Package | What it holds |
|---|---|
| [`@rackbops/docket-core`](packages/core) | the domain, the scheduler, the two lanes, the task-type contract and the **ports** a host implements: Store, Clock, Identity, Notifier, Executor, Fetch |
| [`@rackbops/docket-types`](packages/types) | the task types: reminder, renewal, price, research, scout, wantlist, wantjudge |

docket is a **library**, never a service: it imports no Hono, discord.js, sqlite or fetch, and it
never calls a model. A host supplies the adapters and the surfaces. The host is the tracker plugin in
[Rackbops/rackbops-bot-plugins](https://github.com/Rackbops/rackbops-bot-plugins) (`plugins/tracker`),
on a rackbops-discord-bot instance logged in as Rackbops Clerk, with people in its own store;
[Lepid-Labs/city-hall](https://github.com/Lepid-Labs/city-hall) only queues and runs the model Jobs,
which [Rackbops/docket-runner](https://github.com/Rackbops/docket-runner) executes through the
Claude Code CLI on roshne's subscription, never an API key (plan rev17). The plan of record is
Rackbops/Tooling, `research/city-hall-task-tracker.md` (section 0 is the goal in one page); the
epic is Rackbops/Tooling#816.

## Status

- **0.0.1** -- the scaffold ([#1](https://github.com/Rackbops/docket/issues/1)): the workspace,
  the build, the tests and the publish path.
- **Reminder slice** (Lepid-Labs/city-hall#7, the library half): the model behind the Store
  port, `once` and `calendar` schedules with zone-correct arithmetic, the two lanes, idempotent
  delivery, authorized reads, the decline rule, the capability enum, the task-type contract, the
  in-memory store, and the `reminder` type. city-hall's adapters (SQLite, usr, the Discord bot)
  are the other half and live there.
- **Renewal and price slice** (Lepid-Labs/city-hall#11, the library half): `poll` and `period`
  schedules, type state on the task, the series (prices seen, amounts paid) behind the same
  authorized reads, outcomes that complete a task, a failed run that keeps its schedule, the
  Fetch port reaching plain-code types, and the `renewal` and `price` types with structured
  price extraction. city-hall's half (the SQLite series table, the Fetch adapter, `/renewal`
  and `/price`) lives there.
- **The bot's words** (Lepid-Labs/city-hall#8, the library half): parsing a person's "when",
  schedules in words, the consent DM and registration disclosure, the `/tasks` list, reply
  references that route a button press back as a reply (the owner answers a run, once;
  recipients receive, and may reply in text), the opt-out on every recipient's copy,
  and `STORE_CONTRACT` for a host's Store. city-hall's half (the commands, the Discord Notifier
  on discord-ai's buttons) lives there.
- **Budgets** (plan 5.7 and 5.12, for E7 and E8): each model run charged to its owner, daily
  ceilings per person and for everyone (calls are the hard count), a person held until midnight
  Eastern with one DM and the admins told once, and the usage-limit outcome that requeues,
  charges nobody and waits for the reset. Per-task ceilings are not enforced yet (each Job's
  `maxBudgetUsd` caps one run), but every charge carries its task. The host keeps the `usage` and notice tables and any raised
  ceilings.
- **0.4.0 -- plan rev17** ([#18](https://github.com/Rackbops/docket/issues/18)): the tracker
  plugin hosts docket and people live in its store (no `usrSubject`, no usr link in
  `registrationText`); nothing goes to recall (no Memory port, no recall charges, no `issueKey`).
  Delivery is one Store row per recipient, claimed before each send, so a host keeps no claim
  table and nobody gets a copy twice; one recipient's failure never stops the others. A person
  who cannot be messaged fails at once, a failed send retries after 1 and 2 minutes (three
  sends), a deferral backs off up to eight times, and a send that may have gone out is never
  resent. A run
  records its outcome first (that is when it has fired), advances its schedule, then applies and
  delivers, so a retry never runs the type again or loses the alert. `tickNotify` takes an
  AbortSignal; a paused task's runs wait; a schedule edit keeps a queued snooze. Host changes:
  the core README's "Adopting 0.4.0".
- **0.5.0 -- research** (plan 1.2 row 5, items 59, 61 (proposed), 62; for E8): the `research`
  type, the first execute-lane type. A research run and a reviewer run go through the runner; the
  reviewed answer is DMed and each claim saved as a finding; an optional deadline is honoured.
  Core gains:
  - a follow-up run (`Outcome.followUp`), budget-checked and charged like any model run;
  - findings in the tracker's own store (`addFinding`, `listFindings`, `deleteFindings` for
    forget-me, `visibleFindings`, type-supplied keys for do-not-resurface);
  - an Executor that need not wait for the runner (`JobPendingError`): one Job out at a time,
    collected whatever happens to its task, charged once by Job key, given up after six hours;
  - `finish` always runs, even when `prepare` or the Executor throws;
  - recipients no longer see a task's config and state.

  Host changes: the core README's "Adopting 0.5.0".
- **0.6.0 -- scout and want-list watcher** (plan 1.2 rows 1 and 2, 5.4, items 63, 103 to 105,
  104's give-back; E9): the three types the tracker plugin built and ran live in tracker 0.15.0 to
  0.17.0, moved here unchanged in behaviour. `scout`, the interest scout (execute lane, every N
  days at the owner's hour); `wantlist`, a watch on a pasted page's JSON-LD or BGG's marketplace
  (notify lane, no model); `wantjudge`, the same watch with the model looking at each new listing
  and its seller before it is DMed (execute lane, WebFetch only on the watch's own host). The
  sources are parameters (`wantlistType`, `wantjudgeType`): `TASK_TYPES` carries both watches over
  the page source only, and a host with a BGG token builds its own with `bggSource`. A host's
  Fetch port must honour and strip the `NEVER_EBAY` header. No core change.
- **0.7.0 -- the inbox source** (E9, the alert-email and in-browser routes): an `inbox` source. A host stores
  listings sent in for a watch (alert emails from eBay or BGG, or a search run in someone's own
  browser) and `inboxSource` reads them; the judge opens no page for an inbox watch and judges
  from the listing text alone. No core change.
- **0.8.0 -- research on gathered pages** (E9, the Claude in Chrome route, rackbops-bot-plugins#125):
  `ResearchConfig.sources: "sent"` answers from pages the person's own browser gathered, read
  through the host's `ReadSources` (`researchType({ readSources })`); neither run may fetch
  BoardGameGeek or eBay. `sources` only widens the config (and the intake gains it); a `web`
  request's runs are unchanged. No core change.
- **0.9.0 -- a fuller pass on pages the run could not open** (E9, the Claude in Chrome route,
  rackbops-bot-plugins#125): a research run lists in its answer's optional `blocked` the pages it
  needed and could not open. For a `web` request with a host store (`readSources`), the owner gets
  the reviewed answer at once with a short "Couldn't open:" list; with an hour or more to wait, the
  DM also says a fuller pass is queued, and the task waits (phase `awaiting-pages`) on a follow-up
  at `sourcesExpiry` (14 days, or 10 minutes before a sooner deadline; now exported, with
  `SOURCES_WAIT_DAYS` and `SOURCES_DEADLINE_MARGIN_MINUTES`). When the pages are in, a second
  research run and a reviewer checking it as an update send an "Update to" DM of new and corrected
  findings only, saved tagged `update`. No pages by the expiry, or a passed deadline: one line,
  the first answer stands, no model call. Host changes: `ready` follows the contract in the types
  README (under the task lock, only while awaiting; reschedule the once task to now, then delete
  the queued follow-up row unless it fired or has its Job out), and pages are accepted only while
  awaiting and frozen once the second pass starts. Without a store, for a `sent` request, or with
  nothing blocked, a request runs as in 0.8.0. Core: `MAX_FOLLOW_UPS` rises from 5 to 9, so a
  second pass that is never readied, with a retry in each phase, completes.
- **0.10.0 -- research answers every part of the question, from the best source** (from Rod's
  feedback on a live answer to "the best board game released in 2026, in each of the major categories"): before
  searching, the research run splits the question into the parts it needs answered, settling a
  part another depends on first (the major categories, then the best in each), answers every part
  and names in `uncertain` any it could not settle. The reviewer, and the second pass's update
  reviewer, work out the same parts first, including a list the question takes for granted, and
  never approve an answer that silently skips one: they revise it from the sources or reject it.
  The split is prompt-only: the answer schema and the DM are unchanged.

  The same release makes the run **rest on the best source** (Rod's feedback on an answer that
  said "I didn't check BoardGameGeek"): each part's reference site (BoardGameGeek for board games,
  eBay for listings and prices) is named first. A `web` first pass and its reviewer open
  BoardGameGeek like any site, an ordinary read (their tools never denied it; the prompt now says
  to try it, and what to do when it refuses). eBay is never opened by any run (eBay's User
  Agreement, section 3 (automated access)): a web first pass and its reviewer now deny its fetches
  too (`WEB_DISALLOWED_TOOLS`), where before nothing in a web run's tools or prompt did. Only
  fetches are denied: WebSearch has no domain filter, so a search can still list eBay's pages.
  Runs on gathered pages (a `sent` request, a second pass) never open BoardGameGeek or eBay, as in
  0.9.0.

  Where a fuller pass can follow -- a `web` first pass whose host can read gathered pages -- a
  best source the run could not or may not open goes in `blocked` (its URL only when that is the
  page's real address, never a guessed one), never as a "didn't check" line, and the first pass's
  reviewer revises an answer that leans on secondary sources without it, adding it there; on a
  revise, its entries join the research run's (which it cannot drop) and can start the wait.
  Everywhere else `blocked` is never shown, so the run and the reviewer name the missing source in
  one short `uncertain` line instead. The web reviewer moves a claim resting only on an eBay
  address (a search listing, never an opened page) to `uncertain`. Under the prompts, a belt
  (`withBarredSites`, over `BARRED_SITES`) adds `{site, why: "not opened by the research run"}`
  for a site a summary or uncertain sentence -- the outgoing answer's or the research run's own
  draft's -- says was not read, in a shape tied to the site ("didn't check BoardGameGeek", "BGG
  refused the request", "no BGG ratings"), and for eBay when a finding of either rests only on
  eBay addresses; a passing mention, or a negation about something else ("not common on eBay"),
  adds nothing, and BoardGameGeek is left alone when a finding cites one of its pages. `blocked`
  keeps one entry per page (`blockedKey`: host and path, or the site's name for an entry with no
  URL, which merges into any entry on its site). Stored states, `sent` requests and the 0.9.0
  flows behave as before; the prompts where no wait can follow gain one sentence asking the model
  to name a missing best source in `uncertain`. `researchJob` and `reviewJob` take a new
  options argument (`{ canWait }`) that defaults to `canWait: false` when they are called
  directly; the type's own `prepare` sets it. No core change and no host code change; a host's
  own docs that say the research run cannot open BoardGameGeek need the new wording.
- **0.11.0 -- Firecrawl for the web research run, and the site's own categories** (from Rod's
  "add firecrawl", after comparing a research answer with a run through the Firecrawl tools): a
  `web` first pass and its reviewer may also use `mcp__firecrawl__firecrawl_search` and
  `mcp__firecrawl__firecrawl_scrape` (`FIRECRAWL_TOOLS`, `WEB_ALLOWED_TOOLS`). The prompts say
  WebFetch first, `firecrawl_scrape` for a page that refuses it, always with `proxy: "basic"`
  (never "stealth", "enhanced" or "auto"), one page at a time, never an eBay URL through any tool,
  and `firecrawl_search` like web search; a page Firecrawl is refused too is handled as a refused
  page, as in 0.10.0. The prompt is the control for the proxy and for eBay through Firecrawl:
  permission rules cannot see a tool's parameters. The reviewer's eBay handling and the belt
  apply whichever tool fetched the page. Runs on gathered pages (a `sent` request, a second pass)
  keep their tools and denials. The core's `DEFAULT_ALLOWED_TOOLS` is unchanged; the runner's
  tool ceiling gains the two names in a parallel Rackbops/docket-runner PR, and a runner with no
  Firecrawl key drops them. **Release order:** these Jobs need runner 0.0.6 or later (its
  ceiling admits the two names, and without a Firecrawl key it drops them); a runner older than
  that fails them (0.0.5 throws `ToolCeilingError`), so release the runner before deploying 0.11.0.

  The same release has a question about categories answered in **the best source's own
  categories** -- BoardGameGeek's eight category rankings for board games (`BGG_CATEGORIES`) --
  rather than invented genres, and a category with no qualifying entry answered "none yet" with
  the reason. The summary names every category's pick in one compact run ("Strategy: X; Family:
  Y; ..."), since the DM is cut from the end at 1,900 characters. A web first pass gets a BGG advanced-search hint (`bggCategoryUrl`; the
  `familyids[0]` ids as observed on 2026-10-18, not documented by BGG). The reviewer revises an
  answer that invents categories where the source defines them. No core change and no host code
  change.
- **0.11.1 -- an approve without the draft copied back is still an approve** (t11, 2026-10-18):
  the reviewer of a long eight-category draft twice returned `approve` with no `answer`, and
  `parseReview` refused that as malformed, so the person got "could not check" instead of the
  answer. The type already sends the draft on approve, so `parseReview(value, draft)` now uses
  the draft when an `approve` carries no usable answer. A `revise` without one is still
  malformed. No core change and no host code change; the tracker only needs the version bump.
- **0.12.0 -- Shopify for want-list watches** (Rod, 2026-10-19: "add Shopify to watches,
  daily"): a fourth want-list source, `shopify`, for new copies in stock at Shopify stores. Each
  look is one Shopify catalog search through Firecrawl's Alexandria (`catalog/search_catalog`, 5
  credits), in stock only and narrowed by the watch's top price; a product counts only when every
  word of the watch's search is in its title, and only its available variants that are new (or
  unmarked) are listings.
  `Source.search` takes the watch's limits as an optional third argument (additive). The host
  runs the request with its own Firecrawl key (`ShopifyScrape`); docket opens nothing. No core
  change.
- **0.13.0 -- eBay's own API for want-list watches** (Rod, 2026-10-20, "Build it" on the eBay
  Browse API card): a fifth want-list source, `ebay`, over eBay's Browse API
  (`item_summary/search`, eBay US, newest fifty, narrowed by the watch's top price). A listing
  counts only when every word of the search is in its title; an auction is priced at its current
  bid (or its Buy It Now price, when it has one) and marked "auction"; the seller line is the seller's name, feedback percentage and score.
  The host runs the request with an application token from the owner's eBay developer keys
  (`EbayBrowse`); docket opens nothing, and the judge opens no eBay page. An eBay watch keeps no
  findings (`keepsFindings`): eBay's API License limits how long listing data may be kept and shown,
  so its listings are in the DM only, and its state holds digests of their ids. No core change.

## Use

```sh
pnpm add @rackbops/docket-core @rackbops/docket-types
```

Public npm, no registry token.

## Develop

Requires [just](https://just.systems), Node 24 (`.nvmrc`) and pnpm (the version in
`package.json`'s `packageManager`; `corepack enable` picks it up).

```sh
just install   # pnpm install --frozen-lockfile
just check     # lint, build, typecheck, test -- in that order, see CONTEXT.md
just core test # one package
just fix       # biome, write mode
```

## Release

One version for both packages. `just version 0.1.0` sets it on every package; commit as
`chore(release): v0.1.0`, tag `v0.1.0`, push with tags. The `publish` workflow packs each package
(pnpm rewrites the `workspace:^` range) and publishes to npm by OIDC trusted publishing, with
provenance; `CONTEXT.md` has the one-time npmjs setup and the first-publish caveat.
