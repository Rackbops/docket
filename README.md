# docket

Tracker core library: people, tasks, schedules, task types and ports. Two packages on public npm,
one version, one tag:

| Package | What it holds |
|---|---|
| [`@rackbops/docket-core`](packages/core) | the domain, the scheduler, the two lanes, the task-type contract and the **ports** a host implements: Store, Clock, Identity, Notifier, Executor, Memory, Fetch |
| [`@rackbops/docket-types`](packages/types) | the six task types: reminder, renewal, price, research, scout, wantlist |

docket is a **library**, never a service: it imports no Hono, discord.js, sqlite or fetch, and it
never calls a model. A host supplies the adapters and the surfaces. The first host is
[Lepid-Labs/city-hall](https://github.com/Lepid-Labs/city-hall), whose bot is Rackbops Clerk, built
on discord-ai; the model runs happen in [Rackbops/docket-runner](https://github.com/Rackbops/docket-runner),
through the Claude Code CLI on roshne's subscription, never an API key. The plan of record is
Rackbops/Tooling, `research/city-hall-task-tracker.md` (section 0 is the goal in one page); the
epic is Lepid-Labs/city-hall#4.

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
  references that route a button press back as a reply, the opt-out on every recipient's copy,
  and `STORE_CONTRACT` for a host's Store. city-hall's half (the commands, the Discord Notifier
  on discord-ai's buttons) lives there.
- Next: findings into recall (E7), the execute lane against the runner (E8).

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
