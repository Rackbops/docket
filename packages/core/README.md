# @rackbops/docket-core

The tracker's domain, scheduler, task-type contract and ports, with no platform code: no Hono,
no discord.js, no sqlite, no fetch. A host (Lepid-Labs/city-hall is the first) supplies the
adapters behind the ports.

Today this package is the scaffold: it exports the two lanes and nothing else. The domain lands
per Lepid-Labs/city-hall#7. Design: Rackbops/Tooling, `research/city-hall-task-tracker.md`,
section 5.

```ts
import { LANES, isLane, type Lane } from "@rackbops/docket-core"
```
