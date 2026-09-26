# @rackbops/docket-types

The tracker's task types -- reminder, renewal, price, research, scout, wantlist -- built on
`@rackbops/docket-core`'s contract. Today this package is the scaffold: it exports the type
identifiers and re-exports `Lane`. The types land with their epics (Lepid-Labs/city-hall#7,
#11, #13).

```ts
import { TYPE_IDS, isTypeId, type TypeId } from "@rackbops/docket-types"
```
