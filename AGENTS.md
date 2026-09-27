# docket -- Agent Instructions

The core of the task tracker for roshne and friends on Discord: `@rackbops/docket-core` (domain,
scheduler, lanes, task-type contract, ports) and `@rackbops/docket-types` (the six task types).
Lepid-Labs/city-hall is the host, Rackbops/docket-runner runs the model calls, and the bot is
Rackbops Clerk, built on discord-ai. The plan of record is Rackbops/Tooling
`research/city-hall-task-tracker.md` (section 0 is the goal in one page, section 5 the
architecture); the epic is Lepid-Labs/city-hall#4; this repo's own scaffold is #1.

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
  lives in the host. A type reaches a port only through `RunContext.ports` (today `fetch`),
  never by importing a platform module; string work on what a port returns (price extraction)
  is fine, a DOM or HTTP library is not.
- **The model is never called from here.** Execute-lane types produce a `Job` (a `claude -p`
  call as data) and consume a `JobResult`; the runner executes it. Every model call the tracker
  makes runs through the Claude Code CLI on roshne's subscription, in the runner on roshne's own
  host, never through an API key (plan 5.12): the host holds no Claude credential, and neither
  does this library. There is no API-key path anywhere in the plan and none may be added here;
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` appear in this repo only
  in sentences that forbid them, never in code, config, tests or CI.
- **Two lanes, so a reminder never waits on a model** (plan 5.3). The notify lane ticks every
  minute and never waits on a model; the execute lane runs model Jobs through the runner.
- **Nothing behind the tier-2 wall** (plan 1.3, 5.6). The grantable capability set holds tier 0
  (observe and notify, always on) and tier 1 (writes inside our own systems, granted per type by
  an admin, every use logged) only. Tier 2 -- anything external or irreversible: buy, bid, mail a
  third party, act on an outside account -- has no name in this library and gets none until its
  own design pass.
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
