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

- `research` (category 5, E8): execute lane, `once`. Two `claude -p` Jobs through the runner: a
  research run (the web-search spike's prompt and answer schema, `{summary, findings[{claim,
  sources[]}], uncertain[]}`; about 15 turns and 1 USD, item 61) and a reviewer run (item 62),
  queued as a follow-up, that checks the draft against its sources and approves, revises or
  rejects it (8 turns and 0.5 USD, inferred). An approved or revised answer goes out by DM to the
  owner and accepted recipients and each claim is saved as a finding with its first source; a
  rejected one is reported and nothing is saved. Model output is parsed, capped and cleaned
  before it reaches a message or a finding: no mention can ping, no masked link can hide its
  target, only http(s) URLs count as sources, and the DM stays under Discord's limit. A schema
  miss, a malformed answer, a timeout or an error is retried once; an auth failure once, an hour
  later; a turn or budget cap is reported, not retried. An answer the reviewer did not pass is
  never sent.

The first three call no model. Scout and wantlist land with their epic (#13).

```ts
import { TASK_TYPES, reminder, renewal, price, research, TYPE_IDS, isTypeId } from "@rackbops/docket-types"
```

`TASK_TYPES` is every shipped type keyed by id, ready for the dispatcher. Every type is declared
through `defineTaskType`, which refuses a capability outside the grantable set, and a test here
asserts that over the whole map.
