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
