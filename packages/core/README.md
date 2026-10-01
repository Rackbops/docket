# @rackbops/docket-core

The tracker's domain, scheduler, two lanes, task-type contract and ports, with no platform code:
no Hono, no discord.js, no sqlite, no fetch. A host -- the tracker plugin in
Rackbops/rackbops-bot-plugins (`plugins/tracker`) -- supplies the adapters behind the ports and
gets a tracker; Lepid-Labs/city-hall only queues and runs its model Jobs. Design:
Rackbops/Tooling, `research/city-hall-task-tracker.md`, section 5 (plan rev17).

| Module | What it holds |
|---|---|
| `model` | the records: users, tasks (config and type state), occurrences, events, task history, recipients, blocks, replies, series, findings, usage |
| `ports` | `Store`, `Clock`, `Identity`, `Notifier`, `Executor`, `Fetch`, the Store's input shapes, and the errors a Notifier or Executor throws (`DeliveryFailedError`, `ExecutorUnavailableError`, `JobPendingError`) |
| `memory-store`, `store-contract` | the Store in memory: the reference semantics and the test fake; `STORE_CONTRACT`, those semantics as cases a host runs against its own Store |
| `schedule`, `zoned` | `once`, `calendar`, `poll` and `period` schedules, `nextDue`, `periodDate`, zone-aware wall-clock arithmetic on Intl alone |
| `scheduler`, `dedupe`, `tasks` | one upcoming occurrence per task through its dedupe key; cancel-and-replace on edit, keeping a snooze's run and a follow-up; `createTask` |
| `dispatch`, `delivery` | the notify and execute lanes (an active task's runs only; `tickNotify` takes an AbortSignal), DM delivery claimed in the Store before each send, per-recipient outcomes and retries, crash recovery, replies and snooze; a type's outcome recorded, then applied (state stored, series and findings appended, `complete` ends the task, `followUp` queues one more run), then delivered, so a failed send is retried without running the type again; a Job the runner has not finished is asked about again each tick, charged once |
| `authz`, `consent` | every read takes an identity, the series and findings included; invitations, accept, the decline rule, opt-out, admin lifts |
| `when`, `describe`, `messages`, `refs` | what the bot says and hears: a person's "when" (`parseWhen`), cadences and instants in words, the consent DM, the registration disclosure, the `/tasks` list, and buttons whose reply references route a press back as a reply (`replyButtons`, `replyForRef`): a run's done, snooze and decision are the owner's, once per fired run while the task is active (when the host handles a task's replies one at a time), enforced in `Lanes.reply` on every path; a recipient's copy carries the opt-out and no run actions |
| `text` | `clean`: a person's or a model's text made safe for a DM (no mention pings, no masked link, no control characters, capped); the types package re-exports it |
| `job-state` | where an execute-lane run's Job stands, from its events: its key, whether it is out, `PENDING_LIMIT_MS` |
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

## Adopting 0.5.0

0.5.0 adds what the `research` type (docket-types, plan 1.2 row 5) needs: a follow-up run, stored
findings, and a Job the runner has not finished yet. A host's Store gains three methods and a
usage column, and its Executor takes a third argument. Run `STORE_CONTRACT` against the Store:
three new cases cover the changes.

**Store**

- A `findings` table: `id`, `task_id`, `owner_id`, `occurrence_id` (nullable), `key` (nullable,
  unique when set), `type`, `text`, `tags` (a JSON array of strings), `source` (nullable), `at`.
  Index `findings(task_id)` and `findings(owner_id)`: one serves the task view, the other
  forget-me.
  - `addFinding(finding)` inserts one row. With a `key` already stored it adds nothing and
    returns the stored row (`INSERT ... ON CONFLICT(key) DO NOTHING`, then select), exactly like
    `addSeriesPoint`. The dispatcher keys a finding in one of three ways:
    - `<task>:<key>` when the type gave a key (a deterministic id, for dedupe and
      do-not-resurface, plan 5.2);
    - `<occurrence>:<index>` for a run's other findings;
    - `reply:<reply id>:<index>` for findings from `onReply`.
  - `listFindings({ taskId?, ownerId?, since? })` returns rows oldest first by `at`, ties in
    insertion order (`ORDER BY at, rowid`). `since` is inclusive.
  - `deleteFindings(ownerId)` deletes every finding of the tasks that person owns and returns how
    many. Forget-me calls it beside `deleteDeliveries` and the `usage` delete. A host that erases
    inside a synchronous transaction runs `DELETE FROM findings WHERE owner_id = ?` there instead.
- `usage` gains a nullable `key` column, unique when set. With a key already stored, `addUsage`
  adds nothing and returns the stored row. The execute lane keys each charge by its Job key, so
  a crash between a charge and its run's record never charges one call twice.
- No new occurrence column. A follow-up is an ordinary occurrence whose `dedupeKey` is
  `followup:<occurrence>`. A run's Job state (its key, whether it is out) is read from its own
  `status` events (`job-state.ts`), which the host stores already.
- Each execute tick reads the events of every due execute-lane run (`hasJobOut`), and `reschedule`
  reads them for the task's queued runs. That is cheap at the tracker's size, but index
  `events(occurrence_id)` if the host has not already.

**Executor**

- `run(spec, occurrenceId, jobKey)` takes a third argument, and `spec` may be **null**. Submit
  under `jobKey`, not the occurrence id. It is the occurrence id for a run's first Job and `<occurrence id>:<n>` after the
  n-th usage limit, because city-hall answers a known key with that Job's result, and a usage
  limit's result would otherwise come back for good.
- `run` need not wait for the runner. Submit with `POST /api/execute/jobs` and `key = jobKey`.
  While the Job is not `done` or `failed`, throw `JobPendingError`. Then:
  - The run goes back to the queue, unstarted and uncharged.
  - **Nothing new is submitted while a Job is out.** Each execute tick first asks about every run
    whose Job is out, under the same key: resubmit the same key, or `GET /api/execute/jobs/:id`.
    So Jobs really go one at a time (plan 5.3), and the budget check never misses a call in
    flight.
  - The run skips the budget check while its Job is out: its call is already made, and holding it
    would only delay collecting it.
  - It writes one `submitted` event for the whole wait, and is charged once, when the result
    comes back.
  - `prepare` is **not** called again. Every later ask passes `spec = null`: answer the Job
    already out under `jobKey`, and never submit anything new. So keep what you need to find it by
    key (city-hall's job id from the first POST, say) in the plugin's own store. That way a
    `prepare` that would now decide differently (edited config, a passed deadline) cannot fire
    the run without collecting the Job.
  - Any other error on a Job already out (an HTTP 500, say) is treated like pending: same key, no
    new Job, up to the same limit. The first Job may still run, so it is never resubmitted under a
    new key.
  - An adapter asked with `spec = null` that has no record for `jobKey` (its store lost the
    city-hall job id, say) should throw: the run is then held like a pending one for up to
    `PENDING_LIMIT_MS`, given up and charged one call. So persist the city-hall job id before
    returning from the first ask.
  - While a Job out keeps failing, the run writes one `waiting: ...` event per distinct reason,
    not one per tick.
- The wait is bounded, and **the lane is held for every owner meanwhile**.
  - A Job pending past `SLOW_JOB_MS` (1 hour, inferred) is reported to the admins once, with one
    `error` event on the run.
  - A Job still answering pending (or failing) `PENDING_LIMIT_MS` (6 hours, inferred) after its
    submission is given up. The run writes one `error` event, and the type's `finish` gets
    `{ kind: "error", detail: "the job did not finish in time" }`. That result is charged as one
    call, since the Job may have run. The lane then moves on.
  - A Job is given up only on an answer, never during `ExecutorUnavailableError`. So a Job that
    finished while city-hall was unreachable is collected when city-hall is back.
- "One Job at a time" holds from the tracker's side. A Job it gave up on may still be running at
  the runner, and nothing cancels it there.
- A run whose Job is out is never deleted. `reschedule` and a task completing keep it.
  `reschedule` returns `jobOut: true` so the host can tell the owner the run in flight still
  counts. For a `once` schedule, old or new, it throws `ScheduleError` instead: that run is the
  task, and the edit would run it twice. It is
  collected and charged even if its task was paused, completed or archived meanwhile.
  - For a **paused** task, the outcome is applied and its sends wait for the resume, as for any
    fired run.
  - For a **done** or **archived** task, the outcome is dropped (no DM, no findings, no follow-up)
    and the charge stays.
- `ExecutorUnavailableError` still means nothing could be asked (city-hall unreachable, no
  runner). The run is requeued; a Job already out is asked about under its key next time. **Any
  other error from a first submission is not retried by the core.** It becomes an uncharged
  `{ kind: "error" }` result for the type's `finish`. So throw `ExecutorUnavailableError` for a
  transport failure that may pass.
- A Store error while a pending run goes back to the queue leaves it `running`. The next sweep
  puts it back after `STALE_RUN_MS`, because its Job is on record. A crash between the result and
  the record re-asks the same key, which gives the same result with no second model call, and
  the keyed charge is not counted twice.

**Types and lanes**

- A fired run whose outcome completes a **paused** task does not complete it while it is paused:
  that would make the task done and send at once, through the pause. The run waits, applied.
  The first notify tick after the resume completes the task and sends the message. A task
  archived meanwhile is never turned to done.
- "Done" means the same on both paths. A task set **done** or **archived** while that completion
  waits drops its message, as a Job collected after the task ended does: no DM, its sends are
  dropped, and the findings and the charge already stored stay.

- An execute-lane type's `finish` always runs once its run starts. A `prepare` that throws, or an
  Executor that throws (other than pending, unavailable or a usage limit), becomes an uncharged
  `error` result. So a type can always retry or tell its owner, and a `once` task is never
  stranded silently.
- `prepare` may return `{ outcome }` instead of a JobSpec when no call is needed (a research
  request past its deadline). That is the run's outcome: nothing is submitted or charged.
- `Outcome.followUp: { at? }` asks for one more run of the same task:
  - It is due at `at`, or when the asking run fired.
  - It is queued only after the outcome is applied, so it runs on the state that outcome wrote.
  - It is off the schedule (`isOffSchedule`): materialization never counts it as the next
    scheduled run, and `reschedule` never cancels it.
  - It waits until the asking run has finished (`isFinishing`), and on the execute lane it is
    budget-checked, charged and limited like any model run.
  - It is ignored together with `complete` and from `onReply`.
  - Past `MAX_FOLLOW_UPS` (5) in a row the run writes an error event, the task completes, and
    the owner and admins are told once. A snooze's run in a chain starts a new count.
- `Outcome.findings` are stored when the outcome is applied, each with the task's owner and type.
  `Finding.key` is optional. `visibleFindings(store, actor, taskId, { since? })` serves them to
  the owner, accepted recipients and admins (the series' rule), and returns null for anyone else.
- `visibleTask` and `visibleTasks` now give a recipient the task **without `config` and `state`**.
  Those are the owner's: a research request's draft, including a rejected or unreviewed one,
  lives in `state` (`ResearchState.draft`). Only the owner and admins read it. A host view that
  showed a recipient a task's config reads it from what the recipient was sent instead.

**The research type, in the plugin**

- Add `research` to the types the plugin loads (`TASK_TYPES` has it) and allow it with `notify`.
  `notify` is its only capability, tier 0, so no admin grant is needed; `createTask` gives it.
- The intake's optional `at` becomes the schedule `{ kind: "once", at: at ?? now }`. Its
  optional `deadline` goes into `config.deadline` as an ISO instant.
- Send its DMs with **no allowed mentions** (`allowed_mentions: { parse: [] }`). The type already
  breaks every mention, masked link and mention-spelling URL in model text, but the Notifier is
  the last line.
- The rejection DM quotes the reviewer's problems, model-written text cleaned and capped like the
  rest. Every research DM stays at or under 1900 characters.

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
- The budgets ([#17](https://github.com/Rackbops/docket/pull/17), first released in 0.4.0) add
  `listUsers`, `addUsage`, `listUsage` and `claimNotice`; a 0.3.0 host needs all four, with the
  `usage` and notice rows behind them.
- Forget-me erases more than `deleteDeliveries`: the person's `usage` rows and their
  `budget:person:<id>:*` notices name them too. `deleteDeliveries` is async, so a host that erases
  inside a synchronous database transaction runs the same delete there instead.

**Notifier**

- It keeps no claim table of its own: `deliver` claims each send in the Store first.
- How a send fails decides what happens next, so map Discord's errors carefully:
  - `DeliveryFailedError(message, true)` -- the person cannot be messaged at all (DMs closed,
    left the server, bot blocked): failed for good at once;
  - `DeliveryFailedError(message)` -- nothing went out this time: retried after 1 minute, then
    after 2 more, three sends in all;
  - `ExecutorUnavailableError` -- not now, nothing went out: deferred, no attempt counted,
    retried after 1, 2, 4 ... minutes (doubling, capped at an hour), eight times in all;
  - any other error -- it may have gone out: `unconfirmed`, never resent.
- A claim left open past `STALE_CLAIM_MS` (10 min), or found by `recover()` at start, settles as
  `unconfirmed`. A fired run left `running` past `STALE_RUN_MS` (10 min) goes back to be resumed.

**Lanes and replies**

- Call `recover()` once at start. Owed sends go out on `tickNotify`, never `tickExecute`.
- A paused task's runs do not start, and its owed sends wait; a run that fired before the pause
  is still applied, and its sends wait too. Each pause gives its owed rows a fresh round, so
  pause and resume buy three more sends; that is intended.
- A run is answered once it has finished (`done`, or `failed`), whatever it still owes anyone; a
  fired run still finishing (`isFinishing`) is refused with "still finishing". A host lookup that
  finds "the latest run" to route a reply to must include runs that still owe a delivery, not
  only those whose copies all went out.
- Serialize per task: a task's replies, its edits (`reschedule`) and its runs one at a time. The
  core guards a run's start and a snooze by compare-and-set, but a schedule edit racing a firing
  run can leave a run of the old schedule beside the new one. `tickNotify` walks every task, so a
  host either holds one lock around the whole tick and its edits, or (as the tracker plugin does)
  runs one tick per task with work, under that task's lock, through a Store view that narrows the
  occurrence and delivery lists to that task and leaves users, usage and notices whole.
- The core checks the abort signal between runs; a type whose fetch throws on abort is the host's
  to stop, by passing the signal to its `Fetch` port.
- `visibleOccurrences` hides `record` from anyone but the owner and admins; `visibleDeliveries`,
  `visibleReplies` and `visibleHistory` show a recipient only their own rows, so no recipient
  learns who else receives a task. A host writing `recipient_*`, `blocked` or `block_lifted`
  history starts `detail` with the recipient's id.
- `registrationText(user, { first, notes? })` no longer takes or shows a usr link.
