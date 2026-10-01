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

The first three call no model. Scout and wantlist land with their epic (#13).

```ts
import { TASK_TYPES, reminder, renewal, price, research, TYPE_IDS, isTypeId } from "@rackbops/docket-types"
```

`TASK_TYPES` is every shipped type keyed by id, ready for the dispatcher. Every type is declared
through `defineTaskType`, which refuses a capability outside the grantable set, and a test here
asserts that over the whole map.
