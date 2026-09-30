# @rackbops/docket-core

The tracker's domain, scheduler, two lanes, task-type contract and ports, with no platform code:
no Hono, no discord.js, no sqlite, no fetch. A host -- the tracker plugin in
Rackbops/rackbops-bot-plugins (`plugins/tracker`) -- supplies the adapters behind the ports and
gets a tracker; Lepid-Labs/city-hall only queues and runs its model Jobs. Design:
Rackbops/Tooling, `research/city-hall-task-tracker.md`, section 5 (plan rev17).

| Module | What it holds |
|---|---|
| `model` | the records: users, tasks (config and type state), occurrences, events, task history, recipients, blocks, replies, series, usage |
| `ports` | `Store`, `Clock`, `Identity`, `Notifier`, `Executor`, `Fetch`, the Store's input shapes, and the errors a Notifier or Executor throws (`DeliveryFailedError`, `ExecutorUnavailableError`) |
| `memory-store`, `store-contract` | the Store in memory: the reference semantics and the test fake; `STORE_CONTRACT`, those semantics as cases a host runs against its own Store |
| `schedule`, `zoned` | `once`, `calendar`, `poll` and `period` schedules, `nextDue`, `periodDate`, zone-aware wall-clock arithmetic on Intl alone |
| `scheduler`, `dedupe`, `tasks` | one upcoming occurrence per task through its dedupe key; cancel-and-replace on edit, keeping a snooze's run; `createTask` |
| `dispatch`, `delivery` | the notify and execute lanes (an active task's runs only; `tickNotify` takes an AbortSignal), DM delivery claimed in the Store before each send, per-recipient outcomes and retries, crash recovery, replies and snooze; a type's outcome recorded, then applied (state stored, series appended, `complete` ends the task), then delivered, so a failed send is retried without running the type again |
| `authz`, `consent` | every read takes an identity, the series included; invitations, accept, the decline rule, opt-out, admin lifts |
| `when`, `describe`, `messages`, `refs` | what the bot says and hears: a person's "when" (`parseWhen`), cadences and instants in words, the consent DM, the registration disclosure, the `/tasks` list, and buttons whose reply references route a press back as a reply (`replyButtons`, `replyForRef`): a run's done, snooze and decision are the owner's, once per fired run while the task is active (when the host handles a task's replies one at a time), enforced in `Lanes.reply` on every path; a recipient's copy carries the opt-out and no run actions |
| `budget` | daily ceilings for model runs (plan 5.7, 5.12): `DEFAULT_BUDGET` (2 USD and 20 calls a person, 10 USD and 100 calls in all), days from midnight Eastern, `charge`, `budgetHold`, and the one-time notices; the execute lane charges each run to its owner, holds a person at a ceiling until midnight, stops at the global one, and backs off after a usage limit without charging anyone |
| `contract`, `capabilities`, `job` | `TaskType`, `defineTaskType`, the grantable capability enum (tier 0 and tier 1 only; tier 2 has no name here), the `JobSpec` and `JobResult` a runner speaks |

```ts
import { createTask, Lanes, MemoryStore } from "@rackbops/docket-core"
import { TASK_TYPES } from "@rackbops/docket-types"

const store = new MemoryStore()
const lanes = new Lanes({ store, clock: { now: () => new Date() }, types: TASK_TYPES, notifier })
await lanes.recover()
setInterval(() => lanes.tickNotify(AbortSignal.timeout(30_000)), 60_000)
```

A host replaces `MemoryStore` with its own Store (and proves it by running `STORE_CONTRACT`
against it), supplies a `Notifier` that DMs a user, a `Fetch`
for the plain-code types (the price tracker reads pages through it, via `RunContext.ports`), and an
`Executor` that hands Jobs to the runner. The core never calls a model and holds no credential:
every model call runs in the runner, through the Claude Code CLI on roshne's subscription, never an
API key.

## Adopting 0.4.0

0.4.0 ([#18](https://github.com/Rackbops/docket/issues/18)) changes what a host implements. Run
`STORE_CONTRACT` against the host's Store after each step; every rule below is a case there.

**Store**

- `findUserBySubject` is gone, with `User.usrSubject`: people live in the host's own store.
  `deleteQueuedOccurrences` is gone too. (Outside the Store: `Identity.actorForSubject` and the
  `Memory` port are gone.)
- `deleteOccurrence(id)` deletes one row, only while it is `queued`, and says whether it did.
  `reschedule` cancels through it one row at a time, keeping a snooze's run and any run that has
  fired.
- `updateOccurrenceIf(id, expected, patch)` is a compare-and-set on status: it patches only while
  the row's status is `expected` and returns null otherwise. It must be atomic (one SQL
  `UPDATE ... WHERE id = ? AND status = ?`); the lanes start every run through it.
- `Occurrence.record` is a new nullable JSON column (`OccurrencePatch.record` writes it). A run
  has **fired** once its record is stored, whatever its status; `startedAt` no longer means that.
  `requeueRunning` must set `startedAt` back to null, and keep `record`.
- `SeriesPoint.key` is a new nullable, unique-when-set column: `addSeriesPoint` with a key already
  stored adds nothing and returns the stored point, so a run applied again never appends twice.
- A `deliveries` table, keyed by (`occurrenceId`, `userId`), with `status` (`pending`, `claimed`,
  `sent`, `deferred`, `failed`, `unconfirmed`), `messageId`, `error`, `attempts`, `deferrals`,
  `retryAt`, `createdAt`, `claimedAt` and `settledAt`. A row is **owed** while `retryAt` is set.
  - `planDelivery` inserts a `pending` row owed from `at`; a no-op returning null when the row
    exists.
  - `claimDelivery` takes an owed row: `claimed`, `claimedAt` = `at`, `retryAt` null. Null when
    the row is missing or not owed. Atomic: two callers never both win (`UPDATE ... WHERE
    retryAt IS NOT NULL`).
  - `settleDelivery` writes every field of `DeliverySettle`, so an absent `messageId` or `error`
    clears it.
  - `listDeliveries` filters by run, person, status, and `dueBefore` (owed rows with `retryAt` at
    or before it), oldest first.
  - `deleteDeliveries(userId)` erases a person's rows: forget-me must call it.
- `UsageSource` is `"run"` only: there are no recall charges.

**Notifier**

- It keeps no claim table of its own: `deliver` claims each send in the Store first.
- How a send fails decides what happens next, so map Discord's errors carefully:
  - `DeliveryFailedError(message, true)` -- the person cannot be messaged at all (DMs closed,
    left the server, bot blocked): failed for good at once;
  - `DeliveryFailedError(message)` -- nothing went out this time: retried with a backoff (1, 2,
    4 min ... capped at an hour), three sends in all;
  - `ExecutorUnavailableError` -- not now, nothing went out: deferred, no attempt counted,
    retried with the same backoff, eight times in all;
  - any other error -- it may have gone out: `unconfirmed`, never resent.
- A claim left open past `STALE_CLAIM_MS` (10 min), or found by `recover()` at start, settles as
  `unconfirmed`.

**Lanes and replies**

- Call `recover()` once at start. Owed sends go out on `tickNotify`, never `tickExecute`.
- A paused task's runs do not start, and its owed sends wait. Each pause gives its owed rows a
  fresh round, so pause and resume buy three more sends; that is intended.
- A run that has fired can be answered whatever its status (it may be `queued` or `running` while
  it finishes, then `done` or `snoozed`). A host lookup that finds "the latest run" to route a
  text reply to must include runs that still owe a delivery, not only `done` ones.
- `visibleOccurrences` hides `record` from anyone but the owner and admins; `visibleDeliveries`
  shows a recipient only their own row.
- `registrationText(user, { first, notes? })` no longer takes or shows a usr link.
