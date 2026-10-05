# docket

Tracker core library: people, tasks, schedules, task types and ports. Two packages on public npm,
one version, one tag:

| Package | What it holds |
|---|---|
| [`@rackbops/docket-core`](packages/core) | the domain, the scheduler, the two lanes, the task-type contract and the **ports** a host implements: Store, Clock, Identity, Notifier, Executor, Fetch |
| [`@rackbops/docket-types`](packages/types) | the task types: reminder, renewal, price, research, scout, wantlist, wantjudge |

docket is a **library**, never a service: it imports no Hono, discord.js, sqlite or fetch, and it
never calls a model. A host supplies the adapters and the surfaces. The host is the tracker plugin in
[Rackbops/rackbops-bot-plugins](https://github.com/Rackbops/rackbops-bot-plugins) (`plugins/tracker`),
on a rackbops-discord-bot instance logged in as Rackbops Clerk, with people in its own store;
[Lepid-Labs/city-hall](https://github.com/Lepid-Labs/city-hall) only queues and runs the model Jobs,
which [Rackbops/docket-runner](https://github.com/Rackbops/docket-runner) executes through the
Claude Code CLI on roshne's subscription, never an API key (plan rev17). The plan of record is
Rackbops/Tooling, `research/city-hall-task-tracker.md` (section 0 is the goal in one page); the
epic is Rackbops/Tooling#816.

## Status

- **0.0.1** -- the scaffold ([#1](https://github.com/Rackbops/docket/issues/1)): the workspace,
  the build, the tests and the publish path.
- **Reminder slice** (Lepid-Labs/city-hall#7, the library half): the model behind the Store
  port, `once` and `calendar` schedules with zone-correct arithmetic, the two lanes, idempotent
  delivery, authorized reads, the decline rule, the capability enum, the task-type contract, the
  in-memory store, and the `reminder` type. city-hall's adapters (SQLite, usr, the Discord bot)
  are the other half and live there.
- **Renewal and price slice** (Lepid-Labs/city-hall#11, the library half): `poll` and `period`
  schedules, type state on the task, the series (prices seen, amounts paid) behind the same
  authorized reads, outcomes that complete a task, a failed run that keeps its schedule, the
  Fetch port reaching plain-code types, and the `renewal` and `price` types with structured
  price extraction. city-hall's half (the SQLite series table, the Fetch adapter, `/renewal`
  and `/price`) lives there.
- **The bot's words** (Lepid-Labs/city-hall#8, the library half): parsing a person's "when",
  schedules in words, the consent DM and registration disclosure, the `/tasks` list, reply
  references that route a button press back as a reply (the owner answers a run, once;
  recipients receive, and may reply in text), the opt-out on every recipient's copy,
  and `STORE_CONTRACT` for a host's Store. city-hall's half (the commands, the Discord Notifier
  on discord-ai's buttons) lives there.
- **Budgets** (plan 5.7 and 5.12, for E7 and E8): each model run charged to its owner, daily
  ceilings per person and for everyone (calls are the hard count), a person held until midnight
  Eastern with one DM and the admins told once, and the usage-limit outcome that requeues,
  charges nobody and waits for the reset. Per-task ceilings are not enforced yet (each Job's
  `maxBudgetUsd` caps one run), but every charge carries its task. The host keeps the `usage` and notice tables and any raised
  ceilings.
- **0.4.0 -- plan rev17** ([#18](https://github.com/Rackbops/docket/issues/18)): the tracker
  plugin hosts docket and people live in its store (no `usrSubject`, no usr link in
  `registrationText`); nothing goes to recall (no Memory port, no recall charges, no `issueKey`).
  Delivery is one Store row per recipient, claimed before each send, so a host keeps no claim
  table and nobody gets a copy twice; one recipient's failure never stops the others. A person
  who cannot be messaged fails at once, a failed send retries after 1 and 2 minutes (three
  sends), a deferral backs off up to eight times, and a send that may have gone out is never
  resent. A run
  records its outcome first (that is when it has fired), advances its schedule, then applies and
  delivers, so a retry never runs the type again or loses the alert. `tickNotify` takes an
  AbortSignal; a paused task's runs wait; a schedule edit keeps a queued snooze. Host changes:
  the core README's "Adopting 0.4.0".
- **0.5.0 -- research** (plan 1.2 row 5, items 59, 61 (proposed), 62; for E8): the `research`
  type, the first execute-lane type. A research run and a reviewer run go through the runner; the
  reviewed answer is DMed and each claim saved as a finding; an optional deadline is honoured.
  Core gains:
  - a follow-up run (`Outcome.followUp`), budget-checked and charged like any model run;
  - findings in the tracker's own store (`addFinding`, `listFindings`, `deleteFindings` for
    forget-me, `visibleFindings`, type-supplied keys for do-not-resurface);
  - an Executor that need not wait for the runner (`JobPendingError`): one Job out at a time,
    collected whatever happens to its task, charged once by Job key, given up after six hours;
  - `finish` always runs, even when `prepare` or the Executor throws;
  - recipients no longer see a task's config and state.

  Host changes: the core README's "Adopting 0.5.0".
- **0.6.0 -- scout and want-list watcher** (plan 1.2 rows 1 and 2, 5.4, items 63, 103 to 105,
  104's give-back; E9): the three types the tracker plugin built and ran live in tracker 0.15.0 to
  0.17.0, moved here unchanged in behaviour. `scout`, the interest scout (execute lane, every N
  days at the owner's hour); `wantlist`, a watch on a pasted page's JSON-LD or BGG's marketplace
  (notify lane, no model); `wantjudge`, the same watch with the model looking at each new listing
  and its seller before it is DMed (execute lane, WebFetch only on the watch's own host). The
  sources are parameters (`wantlistType`, `wantjudgeType`): `TASK_TYPES` carries both watches over
  the page source only, and a host with a BGG token builds its own with `bggSource`. A host's
  Fetch port must honour and strip the `NEVER_EBAY` header. No core change.

## Use

```sh
pnpm add @rackbops/docket-core @rackbops/docket-types
```

Public npm, no registry token.

## Develop

Requires [just](https://just.systems), Node 24 (`.nvmrc`) and pnpm (the version in
`package.json`'s `packageManager`; `corepack enable` picks it up).

```sh
just install   # pnpm install --frozen-lockfile
just check     # lint, build, typecheck, test -- in that order, see CONTEXT.md
just core test # one package
just fix       # biome, write mode
```

## Release

One version for both packages. `just version 0.1.0` sets it on every package; commit as
`chore(release): v0.1.0`, tag `v0.1.0`, push with tags. The `publish` workflow packs each package
(pnpm rewrites the `workspace:^` range) and publishes to npm by OIDC trusted publishing, with
provenance; `CONTEXT.md` has the one-time npmjs setup and the first-publish caveat.
