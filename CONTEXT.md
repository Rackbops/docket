# docket -- toolchain and testing reference

Paid-for-once tool knowledge for this repo. Design lives in Rackbops/Tooling's plan of record,
not here.

## Layout

pnpm workspace (`pnpm-workspace.yaml`: `packages/*`), in the shape of Lepid-Labs/discord-ai:
`packages/core` and `packages/types`, each with its own `package.json`, `tsconfig.json`
(extending `tsconfig.base.json`), `Justfile`, `src/` and `test/`. The root `Justfile` exposes
each package as a module (`just core test`, `just types build`).

## Order matters

`docket-types` depends on `docket-core` through `workspace:^`, and core's `exports` point at
`dist/`. So:

- `pnpm -r run build` builds in topological order (core first) -- fine.
- `pnpm -r run typecheck` on a clean tree fails in `types` (`Cannot find module
  '@rackbops/docket-core'`) until core is built. `just check` runs lint, **build**, typecheck,
  test in that order for this reason. CI does the same.
- vitest in `types` resolves core the same way, so `just types test` also needs `just core
  build` first; `just check` from the root covers it.

## Toolchain

- Node 24 (`.nvmrc`; `engines.node >= 24`), pnpm from `packageManager` (Corepack), TypeScript 7,
  vitest 5, Biome 2 -- the versions rackbops-node-app-kit runs, so Renovate keeps them in step
  across Rackbops.
- Biome 2 reads `.gitignore` (`vcs.useIgnoreFile`), so `dist/` and `node_modules/` need no
  separate ignore list. Semicolons are **as needed**; `just fix` writes the formatting.
- `tsc` (not `tsc -b`): per-package plain builds, topological order from pnpm, no project
  references to maintain.

## Publishing

- One version, both packages, one `v*` tag. `just version X.Y.Z` runs `npm version` in every
  package with `--no-git-tag-version`; commit, tag, push with tags. The tag must be
  **annotated** (`git tag -a vX.Y.Z -m vX.Y.Z`): `git push --follow-tags` pushes annotated tags
  only, so a lightweight `git tag vX.Y.Z` never reaches GitHub and `publish.yml` never runs.
- `publish.yml` is rackbops-node-app-kit's OIDC trusted-publishing workflow with one change:
  each package is packed with `pnpm pack` and the tarball is published, because pnpm rewrites
  `workspace:^` to the published version and `npm publish` from the directory would not.
- One-time setup on npmjs.com, per package: a trusted publisher for organization `Rackbops`,
  repository `docket`, workflow `publish.yml`, environment blank. A trusted publisher can only be
  added to a package that already exists, so the **first** publish of each name uses the
  `NPM_TOKEN` break-glass (set the repo secret, tag, then remove the secret). That token must
  be a granular access token with Read and write on **All packages** (or the `rackbops`
  organization scope): one limited to selected existing packages cannot create a new name, and
  npm answers the publish with a bare 404 "not found or no permission" (seen 2026-09-27 on
  0.0.1). Bypass 2FA must be on for CI to use it. npm has announced it is restricting such
  tokens for direct publishing, so if a future first publish fails on 2FA rather than 404, publish
  that first version from a logged-in terminal instead (`pnpm publish` in each package folder,
  core before types), then add the trusted publishers.
- A tag can also be created from the GitHub release page (`/releases/new?tag=vX.Y.Z&target=main`)
  when a local push is not at hand; it triggers `publish.yml` the same way.
- Verify a tarball before the first release: `cd packages/types && pnpm pack` and check that the
  packed `package.json` carries a real version for `@rackbops/docket-core`, not `workspace:^`.

## Repo stamps

Labels come from Rackbops/Tooling's `sync_labels.py` (`--repo Rackbops/docket` or the daily
sweep); Renovate extends `github>Rackbops/renovate-config`; `push-notify.yml` needs the
`DISCORD_PUSH_WEBHOOK` repository secret to post.
