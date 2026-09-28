# Purpose

## Problem being solved

roshne and friends on Discord want one place that keeps track of repeatable and one-off tasks:
"remind me", "watch for this", "search for that every day", and a record of what got done.
Lepid-Labs/city-hall is growing into that tracker. Its core -- who owns what, when it is due, what
went out, what came back -- must be liftable out of city-hall later, so by Nazu's project standard
it is a library from the start: this one.

## What docket is

The tracker's domain, scheduler, two lanes (notify and execute, so a reminder never waits on a
model), task-type contract and ports, plus the six task types: reminders; renewals and expiries;
a price tracker; one-off research with a reviewer; an interest scout; a want-list watcher. A host
implements the ports (SQLite store, usr identity, Discord notifier, the `claude -p` runner as
executor, recall as memory, a fetch for the plain-code types) and gets a tracker.

What a type may do is tiered: tier 0, observe and notify, always; tier 1, writes inside our own
systems, only when an admin grants it per type, every use logged. Tier 2, anything external or
irreversible, has no name in the library until its own design pass.

## Non-goals

- Running anything. No process, no port, no credential, no model call. Every model call the
  tracker makes runs through the Claude Code CLI on roshne's subscription, in the runner on
  roshne's own host, never an API key; the host holds no Claude credential either.
- Knowing about Discord, usr, recall, sqlite or the CLI. Those are adapters in the host.
- A general workflow engine. Six task types and the contract they share.

Goal and design: Rackbops/Tooling, `research/city-hall-task-tracker.md`, section 0 (the goal in
one page) and section 5 (the architecture). Epic: Lepid-Labs/city-hall#4.
