# @rackbops/docket-types

The tracker's task types, built on `@rackbops/docket-core`'s contract. Shipped so far:

- `reminder` (Lepid-Labs/city-hall#7): notify lane, `once` or `calendar`, done and snooze replies.
- `renewal` (city-hall#11): a `period` schedule rolling from the renewal date, asking keep /
  cancel / renewed at lead time; the decision and the amount recorded per period (the current
  row in the task's state, the history in the series); cancel ends the task.
- `price` (city-hall#11): a `poll` schedule; each run reads the page through the host's `Fetch`
  port, extracts the price structurally (JSON-LD, product and Open Graph meta tags, a JSON body,
  or the owner's pattern; `extractPrice`), appends it to the series and alerts once per crossing
  of the drop line, measured from the first, last (default) or peak price seen; done stops it.

- `research` (category 5, E8): execute lane, `once`, an optional deadline. Two `claude -p` Jobs
  go through the runner:
  - a research run: the web-search spike's prompt and answer schema, `{summary,
    findings[{claim, sources[]}], uncertain[]}`, about 15 turns and 1 USD (item 61, proposed and
    not yet decided);
  - a reviewer run (item 62), queued as a follow-up, which checks the draft against its sources
    and approves, revises or rejects it (8 turns and 0.5 USD, inferred).

  On **approve** the stored draft goes out by DM to the owner and accepted recipients; on
  **revise**, the reviewer's corrected answer. Each claim is saved as a finding with its first
  source. A **rejected** answer is reported and nothing is saved. An answer the reviewer did not
  pass is never sent; the draft stays in the task's state, which only the owner and admins see.

  Model output is parsed, capped and cleaned before it reaches a message or a finding. No mention
  can ping, no masked link can hide its target, only http(s) URLs that spell no mention count as
  sources, and every DM stays under Discord's limit.

  Failures:
  - a schema miss, a malformed answer, a timeout or an error (including an Executor or `prepare`
    that threw, or a Job not back in six hours): retried once;
  - an auth failure: retried once, an hour later;
  - a turn or budget cap: reported, not retried;
  - a research run that would start past its deadline: makes no call and tells the owner.

  A request costs up to 1.5 USD when every run succeeds, and up to about 3 USD with one retry per
  phase. The CLI can end a run over its cap.

  **Gathered pages** (0.8.0): with `sources: "sent"`, both runs work from pages the person's own
  browser gathered and the host stored, quoted into their prompts as escaped data between
  markers: up to 10 pages, 12,000 characters each and 100,000 in all. Neither run may fetch
  BoardGameGeek or eBay (`SENT_DISALLOWED_TOOLS`); both may still search and fetch the rest of the
  web. `researchType({ readSources })` builds the type over the host's store, read by task id at
  each run; `research` (and `TASK_TYPES`) has none, so a `sent` request there is not run. When a
  `sent` request runs is the host's: it moves the run to now once the pages are in. A run with no
  usable page, or a host with no store, makes no model call and tells the owner (in the review
  phase, that the answer could not be checked); a host's read error is retried once like any
  failed run. The intake lists the new `sources` option, which a host without a store should not
  offer.

  **A fuller pass on blocked pages** (0.9.0): the research run may list in `blocked` (at most 6,
  each `{site, url?, why}`, never shown in the answer) the pages it needed and could not open:
  refused, a 403, a CAPTCHA, a sign-in wall. When the review passes, the research run's own draft
  lists any, the request is a `web` one (a `sent` request already had the person's browser and runs
  as in 0.8.0) and the host has a store (`readSources`), the owner gets one DM: the reviewed answer
  and a "Couldn't open:" list. With at least an hour (`MIN_SOURCES_WAIT_MS`) before
  `sourcesExpiry(now, deadline)` -- 14 days (`SOURCES_WAIT_DAYS`), or 10 minutes
  (`SOURCES_DEADLINE_MARGIN_MINUTES`) before a sooner deadline -- the DM also asks the owner to have
  Claude in Chrome gather pages for the request before the expiry, and the task waits in phase
  `awaiting-pages` (state `pass`, `blocked`, `earlier`) on a follow-up due at the expiry; with less,
  the task ends there. The findings are saved either way. The wait sends nothing, runs nothing and
  charges nothing.

  **The host's `ready`** for such a task, run under the task's lock like any edit:
  1. Only while `researchState(task.state).phase === "awaiting-pages"`; otherwise answer
     "started".
  2. If the task's queued `followup:` row has fired (`hasFired`) or has its Job out
     (`hasJobOut`), answer "started".
  3. `reschedule` the once task to now (a `ScheduleError`, which a Job out raises, is "started").
  4. Then delete the queued `followup:` row, only if `!hasFired(o) && !(await hasJobOut(store, o))`.
     Core's `reschedule` cancels scheduled runs only, never a follow-up, so a row left in place
     fires at the expiry too: a second pass still waiting on its first run then, or retrying, is
     started a second time (one that has ended answers "already answered" and stops).

  The host accepts pages for the request only while it is `awaiting-pages`, and freezes them once
  the second pass's run starts: its research run and its reviewer each read the pages, and must
  read the same ones.

  The second pass's research run gets the pages and the earlier answer (escaped, between markers)
  and answers with only new or corrected findings, under `SENT_DISALLOWED_TOOLS`. Its reviewer gets
  the update, the earlier answer and the pages, and checks it as an update: each new claim is
  supported by its source, a "Correction:" claim really corrects the earlier answer and is
  supported, and nothing is repeated. The owner gets an "Update to <title>:" DM of those findings
  (a claim the first answer already made, case and spacing aside, is dropped), or one line when
  there are none; they are saved tagged `["research", verdict, "update"]` beside the first pass's.
  With no pages by the expiry, past the deadline, on a rejected update or on a second failure, the
  task ends with one line: the first answer stands. With no store, a `sent` request, or nothing
  blocked, a request runs exactly as in 0.8.0; the answer schema gains the optional field (and with
  it the reviewer's schema, which embeds it, for every request) and the research prompt one sentence
  asking for it. A second pass that is never readied, with one retry in
  every phase, is a chain of eight runs, inside core's `MAX_FOLLOW_UPS` (9 from 0.9.0).

  **Every part of the question** (0.10.0): before searching, the research run splits the question
  into the parts it needs answered, including any list the question takes for granted, and
  settles a part another depends on first: "the best game of 2026 in each major category" is the
  major categories, then the best in each. It answers every part, in the summary and the findings,
  and names in `uncertain` any part it could not settle and why. The reviewer works out the same
  parts before its other checks, and never approves an answer that silently skips one: `revise`
  (fill the part from the sources, or name it in `uncertain` when they cannot settle it) or
  `reject`. The second pass asks the same of an update: a part the earlier answer left unsettled
  that the pages settle is a new finding, and an update that skips it is revised or rejected. The
  split is prompt-only, with no `parts` field: the summary and the findings already carry each
  part's answer, a separate list would repeat them inside the DM's 1,900 characters, and each of
  its lines would be a claim with no source of its own. So the schemas (but for the wider
  `blocked` description, below), the DM, stored states and the 0.9.0 flows are as they were.

  **The best source** (0.10.0): before searching, the research run names each part's reference
  site -- BoardGameGeek for board games, eBay for listings and sold prices, otherwise the maker,
  the standards body or the official record -- and rests the answer on it. A `web` first pass and
  its reviewer open BoardGameGeek like any site (an ordinary read, nothing to get round a
  refusal). eBay is never opened by any run (eBay's User Agreement, section 3 (automated access)):
  a web first pass and its reviewer deny its fetches (`WEB_DISALLOWED_TOOLS`, new; before 0.10.0 a
  web run had no eBay denial), and a run on gathered pages (a `sent` request, a second pass) never
  opens either site (`SENT_DISALLOWED_TOOLS`, now built from `BARRED_SITES`). Only fetches are
  denied: WebSearch has no domain filter, so a search can still list their pages.

  The answer schema's `blocked` description now also covers the best source for a part that the
  run could not or may not open. What the run does with a best source it could not open depends on whether a fuller pass can
  follow (`ResearchJobOptions.canWait`, which `prepare` sets for a `web` first pass whose host has
  `readSources`):
  - **It can:** the source goes in `blocked` -- a refused page (a 403, a CAPTCHA or challenge
    page, an empty or blocked body, a sign-in wall) or eBay -- with its URL only when that is the
    page's real address (such as BoardGameGeek's ranking or browse page), never a guessed one, and
    never as "I didn't check" in the summary or `uncertain`. The reviewer revises an answer that
    leans on secondary sources while the best source is neither cited nor in `blocked`, adding it
    there, and moves a "didn't check" line to `blocked`.
  - **It cannot** (no store, a `sent` request, a second pass): `blocked` is never shown, so the run
    names the missing source in one short `uncertain` line ("BoardGameGeek was not among the pages
    read"), and a web reviewer revises an answer to add that line.
  - A web reviewer moves a claim resting only on an eBay address (a search listing, never an opened
    page) to `uncertain`.

  The wait's list is the research run's own, then on a revise any the reviewer added (an approve
  sends the stored draft, so it adds none; no reviewer drops one), one entry per site
  (`uniqueBlocked`, keyed by `blockedKey`: the URL's host, or the site's name, so "BoardGameGeek"
  and "boardgamegeek.com" merge), then the belt's: `withBarredSites` adds `{site,
  why: NOT_OPENED_WHY}` (no URL) for a site of `BARRED_SITES` that a sentence of the summary or an
  uncertain line names as not read -- the outgoing answer's, or the research run's own draft's, so
  a reviewer that rewords "I didn't check BoardGameGeek" into "No rating-based ranking was
  available" still leaves the wait. "Not read" is a negated did/could/can/was/is/has/have/had
  (straight or curly apostrophe), "not (been) checked/opened/read", "without checking/opening/
  reading", "unable", "refused", "blocked", "unavailable", "403", "CAPTCHA" and the like, or "no
  <site> data/ratings/rankings"; "e.g." and "i.e." do not end a sentence. eBay also counts when a
  finding rests only on eBay addresses. A passing mention counts for neither, so a question that
  only mentions eBay starts no 14-day wait. BoardGameGeek is left alone when a finding of the
  outgoing answer cites one of its pages; eBay, never opened, has no such exemption. At most 6 in
  all. Nothing the model wrote is stripped from the DM; the "Couldn't open:" list and the queued
  line say what was not opened.

- `scout` (category 1, E9): execute lane, `calendar` every N days at the owner's hour (the host bounds N; the tracker
  plugin allows 1 to 30). One
  `claude -p` Job a run (WebSearch and WebFetch; 30 turns, 1.50 USD, 10 minutes, item 61 proposed)
  asks for five to ten things through a gift lens; an item shown once is never shown again (the
  state keeps the newest 300 digests, each item is also a finding).
- `wantlist` (category 2, E9): notify lane, `poll`, no model. Reads a source each run, keeps the
  listings within the owner's limits and DMs the new ones with a Done button, each a finding.
  Sources: `pageSource` (a pasted page's JSON-LD `ItemList`s and `Product`s, through the host's
  Fetch port, never eBay), `bggSource` (BGG's XML API, with the host's token) and `inboxSource`
  (listings the host stored for the watch's inbox key: alert emails, or searches someone ran in
  their own browser and sent in; `submittedListing` cleans each one, and the judge opens no
  page for such a watch).
- `wantjudge` (category 2, plan 5.4, item 63): the same watch on the execute lane. New listings
  are read in plain code (no charge), then one Job has the model judge each one and its seller
  (WebFetch only on the watch's own host, never WebSearch or the runner's files; 12 turns,
  0.50 USD, 5 minutes). The DM puts the ones worth a look first with the model's note; a look
  that fails for good sends the listings unchecked.

`reminder`, `renewal`, `price` and `wantlist` call no model.

`wantlistType(sources)` and `wantjudgeType(sources)` build the two watches over the sources a
host can run; `TASK_TYPES` has them over `pageSource` only. What the want-list types ask of a
host:

- its Fetch port refuses any hop to eBay when a read carries the `NEVER_EBAY` header, and does
  not send that header on;
- its Fetch port reaches only public addresses, checked after the name lookup: the judge grants
  the runner WebFetch on the watch's own host only because the host's reads already reach it;
- `bggSource` gets a Fetch that hands back the body as sent and follows no redirect, so BGG's
  token never leaves BGG's host;
- `inboxSource(read)` gets a `read(key)` that returns what was sent in for that inbox, oldest
  first; the host decides who may send to an inbox and keeps it from growing without end;
- the DM text names the tracker plugin's `/task history` command, and a judged watch with no
  Fetch says "this bot reads no pages".

`wantjudgeType`'s `wait` (BGG's spacing, default `setTimeout`) and `bggSource`'s `now` (default
`Date.now`) can be injected; a host that keeps time behind its Clock passes them.

```ts
import { TASK_TYPES, reminder, renewal, price, research, scout, TYPE_IDS, isTypeId } from "@rackbops/docket-types"
import { bggSource, inboxSource, pageSource, wantjudgeType, wantlistType } from "@rackbops/docket-types"
```

`TASK_TYPES` is every shipped type keyed by id, ready for the dispatcher. Every type is declared
through `defineTaskType`, which refuses a capability outside the grantable set, and a test here
asserts that over the whole map.
