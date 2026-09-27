# @rackbops/docket-types

The tracker's task types, built on `@rackbops/docket-core`'s contract. Shipped so far:
`reminder` (Lepid-Labs/city-hall#7): notify lane, `once` or `calendar`, done and snooze replies.
The others land with their epics: renewal and price (#11), scout and wantlist (#13), research
with the runner (E8).

```ts
import { TASK_TYPES, reminder, TYPE_IDS, isTypeId } from "@rackbops/docket-types"
```

`TASK_TYPES` is every shipped type keyed by id, ready for the dispatcher. Every type is declared
through `defineTaskType`, which refuses a capability outside the grantable set, and a test here
asserts that over the whole map.
