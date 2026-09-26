# Purpose

## Problem being solved

roshne and friends on Discord want one place that keeps track of repeatable and one-off tasks:
"remind me", "watch for this", "search for that every day", and a record of what got done.
Lepid-Labs/city-hall is growing into that tracker. Its core -- who owns what, when it is due, what
went out, what came back -- must be liftable out of city-hall later, so by Nazu's project standard
it is a library from the start: this one.

## What docket is

The tracker's domain, scheduler, two lanes (notify and execute), task-type contract and ports,
plus the six task types. A host implements the ports (SQLite store, usr identity, Discord
notifier, the `claude -p` runner as executor, recall as memory) and gets a tracker.

## Non-goals

- Running anything. No process, no port, no credential, no model call.
- Knowing about Discord, usr, recall, sqlite or the CLI. Those are adapters in the host.
- A general workflow engine. Six task types and the contract they share.

Design: Rackbops/Tooling, `research/city-hall-task-tracker.md`, section 5. Epic:
Lepid-Labs/city-hall#4.
