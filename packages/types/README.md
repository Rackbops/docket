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

None of the three calls a model. The others land with their epics: scout and wantlist (#13),
research with the runner (E8).

```ts
import { TASK_TYPES, reminder, renewal, price, TYPE_IDS, isTypeId } from "@rackbops/docket-types"
```

`TASK_TYPES` is every shipped type keyed by id, ready for the dispatcher. Every type is declared
through `defineTaskType`, which refuses a capability outside the grantable set, and a test here
asserts that over the whole map.
