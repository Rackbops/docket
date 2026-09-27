# docket

Tracker core library: people, tasks, schedules, task types and ports. Two packages on public npm,
one version, one tag:

| Package | What it holds |
|---|---|
| [`@rackbops/docket-core`](packages/core) | the domain, the scheduler, the two lanes, the task-type contract and the **ports** a host implements: Store, Clock, Identity, Notifier, Executor, Memory, Fetch |
| [`@rackbops/docket-types`](packages/types) | the six task types: reminder, renewal, price, research, scout, wantlist |

docket is a **library**, never a service: it imports no Hono, discord.js, sqlite or fetch. A
host supplies the adapters. The first host is [Lepid-Labs/city-hall](https://github.com/Lepid-Labs/city-hall),
the Rackbops Clerk bot; the model runs happen in [Rackbops/docket-runner](https://github.com/Rackbops/docket-runner).
The plan of record is Rackbops/Tooling, `research/city-hall-task-tracker.md`; the epic is
Lepid-Labs/city-hall#4.

## Status

- **0.0.1** -- the scaffold ([#1](https://github.com/Rackbops/docket/issues/1)): the workspace,
  the build, the tests and the publish path.
- **Reminder slice** (Lepid-Labs/city-hall#7, the library half): the model behind the Store
  port, `once` and `calendar` schedules with zone-correct arithmetic, the two lanes, idempotent
  delivery, authorized reads, the decline rule, the capability enum, the task-type contract, the
  in-memory store, and the `reminder` type. city-hall's adapters (SQLite, usr, the Discord bot)
  are the other half and live there.
- Next: renewal and price (#11), findings into recall (E7), the execute lane against the runner
  (E8).

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
