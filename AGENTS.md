# docket -- Agent Instructions

Tracker core library for the Rackbops Clerk: `@rackbops/docket-core` (domain, scheduler, lanes,
task-type contract, ports) and `@rackbops/docket-types` (the six task types). The plan of record
is Rackbops/Tooling `research/city-hall-task-tracker.md` (section 5 is the architecture); the
epic is Lepid-Labs/city-hall#4; this repo's own scaffold is #1.

My personal global instructions govern *how I work* -- the review gate, escalation, git and
shipping, tool routing, shell choice. Claude Code loads them from `~/.claude/CLAUDE.md`; Codex
from `~/.codex/AGENTS.md`. They are **not restated here**; this file covers only what a session
needs to know about the code in this repo.

**Commit convention:** Conventional Commits `type(scope): subject`; PR titles are checked by the
`PR guidelines` workflow (types: build, chore, ci, docs, feat, fix, perf, refactor, revert,
style, test). Merges land as squash commits titled `<subject> (#N)`.

---

## What this repo is, and is not

- **A library, never a service** (Nazu's project standard, Lepid-Labs/city-hall#6). Nothing here
  starts a process, opens a port, or holds a credential. A host does that behind the ports.
- **No platform code.** `docket-core` imports no Hono, discord.js, sqlite, fetch or Discord
  types. Anything that talks to the outside world is a port (`Store`, `Clock`, `Identity`,
  `Notifier`, `Executor`, `Memory`, `Fetch`) with an in-memory fake in the tests; the adapter
  lives in the host.
- **The model is never called from here.** Execute-lane types produce a `Job` (a `claude -p`
  call as data) and consume a `JobResult`; the runner executes it. There is no API-key path
  anywhere in the plan and none may be added here.
- **One version for both packages**, bumped together (`just version`), published together on a
  `v*` tag. `docket-types` depends on `docket-core` with `workspace:^`.

## Ground truth

The code is the source; the plan of record in Rackbops/Tooling is the design. Where they
disagree, the plan is revised by PR there, not silently here. A design fact quoted in a
doc-comment names its plan section (`5.3`, `5.4`, `5.12`).

## Testing & checks

CI is `.github/workflows/ci.yml`: `just install` then `just check`, which runs **lint, build,
typecheck, test in that order** -- `docket-types` resolves `docket-core` through core's `dist`,
so a typecheck before a build fails with a missing module. Run `just check` before staging.
Tests live in each package's `test/` (vitest), never under `src/`, so `files` in `package.json`
stays honest. `CONTEXT.md` has the toolchain notes.

## Code style

TypeScript ESM, `strict`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Biome 2 is the
formatter and linter (`biome.json`: two spaces, double quotes, **no semicolons**, line width
100); `just fix` writes. Keep I/O at the edges: a function that can be pure is pure, and the
ports are the only edges. ASCII in prose files; `--` in place of a dash.

## Key gotchas

- Typecheck before build fails for `docket-types` (see above). `just check` has the right order.
- `npm publish` from a package directory would ship `"workspace:^"` verbatim; the publish
  workflow packs with `pnpm pack` first, which rewrites it. Do not "simplify" that step.
- The first publish of a **new** package name needs the `NPM_TOKEN` break-glass once: a trusted
  publisher on npmjs.com can only be configured for a package that already exists.
- `push-notify.yml` posts to Discord on every merge to main that touches anything beyond
  README/CONTEXT/docs. `AGENTS.md` and `CLAUDE.md` are deliberately not muted: they steer the
  agent, so a change is behaviour, not prose.
