# Purpose

## Problem being solved

roshne and friends on Discord want one place that keeps track of repeatable and one-off tasks:
"remind me", "watch for this", "search for that every day", and a record of what got done.
The tracker is a Rackbops bot plugin (the tracker plugin in Rackbops/rackbops-bot-plugins, on a
rackbops-discord-bot instance logged in as Rackbops Clerk); Lepid-Labs/city-hall only queues and
runs its model Jobs, through Rackbops/docket-runner (plan rev17). Its core -- who owns what, when
it is due, what went out, what came back -- must be importable by any host, so by Nazu's project
standard it is a library from the start: this one.

## What docket is

The tracker's domain, scheduler, two lanes (notify and execute, so a reminder never waits on a
model), task-type contract and ports, plus the six task types: reminders; renewals and expiries;
a price tracker; one-off research with a reviewer; an interest scout; a want-list watcher. A host
implements the ports (a SQLite store with people in it, a Discord notifier, an executor that
submits `claude -p` Jobs to city-hall for the runner, a fetch for the plain-code types) and gets a
tracker.

What a type may do is tiered: tier 0, observe and notify, always; tier 1, writes inside our own
systems, only when an admin grants it per type, every use logged. Tier 2, anything external or
irreversible, has no name in the library until its own design pass.

## Non-goals

- Running anything. No process, no port, no credential, no model call. Every model call the
  tracker makes runs through the Claude Code CLI on roshne's subscription, in the runner on
  roshne's own host, never an API key; the host holds no Claude credential either.
- Knowing about Discord, city-hall, sqlite or the CLI. Those are adapters in the host.
- A general workflow engine. Six task types and the contract they share.

Goal and design: Rackbops/Tooling, `research/city-hall-task-tracker.md`, section 0 (the goal in
one page) and section 5 (the architecture). Epic: Rackbops/Tooling#816.
