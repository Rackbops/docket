# @rackbops/docket-core

The tracker's domain, scheduler, two lanes, task-type contract and ports, with no platform code:
no Hono, no discord.js, no sqlite, no fetch. A host (Lepid-Labs/city-hall is the first) supplies
the adapters behind the ports and gets a tracker. Design: Rackbops/Tooling,
`research/city-hall-task-tracker.md`, section 5; this slice is Lepid-Labs/city-hall#7.

| Module | What it holds |
|---|---|
| `model` | the records: users, tasks (config and type state), occurrences, events, task history, recipients, blocks, replies, series, usage |
| `ports` | `Store`, `Clock`, `Identity`, `Notifier`, `Executor`, `Memory`, `Fetch`, and the Store's input shapes |
| `memory-store`, `store-contract` | the Store in memory: the reference semantics and the test fake; `STORE_CONTRACT`, those semantics as cases a host runs against its own Store |
| `schedule`, `zoned` | `once`, `calendar`, `poll` and `period` schedules, `nextDue`, `periodDate`, zone-aware wall-clock arithmetic on Intl alone |
| `scheduler`, `dedupe`, `tasks` | one upcoming occurrence per task through its dedupe key; cancel-and-replace on edit; `createTask` |
| `dispatch`, `delivery` | the notify and execute lanes, idempotent DM delivery, crash recovery, replies and snooze; a type's outcome applied: state stored, series appended, `complete` ends the task |
| `authz`, `consent` | every read takes an identity, the series included; invitations, accept, the decline rule, opt-out, admin lifts |
| `when`, `describe`, `messages`, `refs` | what the bot says and hears: a person's "when" (`parseWhen`), cadences and instants in words, the consent DM, the registration disclosure, the `/tasks` list, and buttons whose reply references route a press back as a reply (`replyButtons`, `replyForRef`): a run's done, snooze and decision are the owner's, once per fired run while the task is active (when the host handles a task's replies one at a time), enforced in `Lanes.reply` on every path; a recipient's copy carries the opt-out and no run actions |
| `budget` | daily ceilings for model runs (plan 5.7, 5.12): `DEFAULT_BUDGET` (2 USD and 20 calls a person, 10 USD and 100 calls in all), days from midnight Eastern, `charge` (a host charges recall's extraction here), `budgetHold`, and the one-time notices; the execute lane charges each run to its owner, holds a person at a ceiling until midnight, stops at the global one, and backs off after a usage limit without charging anyone |
| `contract`, `capabilities`, `job` | `TaskType`, `defineTaskType`, the grantable capability enum (tier 0 and tier 1 only; tier 2 has no name here), the `JobSpec` and `JobResult` a runner speaks |

```ts
import { createTask, Lanes, MemoryStore } from "@rackbops/docket-core"
import { TASK_TYPES } from "@rackbops/docket-types"

const store = new MemoryStore()
const lanes = new Lanes({ store, clock: { now: () => new Date() }, types: TASK_TYPES, notifier })
await lanes.recover()
setInterval(() => lanes.tickNotify(), 60_000)
```

A host replaces `MemoryStore` with its own Store (and proves it by running `STORE_CONTRACT`
against it), supplies a `Notifier` that DMs a user, a `Fetch`
for the plain-code types (the price tracker reads pages through it, via `RunContext.ports`), and an
`Executor` that hands Jobs to the runner. The core never calls a model and holds no credential:
every model call runs in the runner, through the Claude Code CLI on roshne's subscription, never an
API key.
