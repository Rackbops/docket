import {
  CAPABILITIES,
  isLane,
  type Occurrence,
  type Reply,
  type RunContext,
  type Task,
  type User,
} from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"

import { isTypeId, reminder, snoozeUntil, TASK_TYPES } from "../src/index.js"

const now = new Date("2026-03-02T14:00:00.000Z")
const owner = { id: "u1", timeZone: "America/New_York", preferredHour: 9 } as User
const task = { id: "t1", ownerId: "u1", type: "reminder", config: { text: "dentist" } } as Task
const occurrence = { id: "o1", taskId: "t1" } as Occurrence

function ctx(): RunContext<{ text: string }> {
  return {
    task,
    occurrence,
    owner,
    recipients: [],
    config: { text: "dentist" },
    state: null,
    now,
    ports: {},
    history: { events: [], replies: [], series: [] },
  }
}

describe("every shipped type", () => {
  it("declares only grantable capabilities, a known lane, and a known id", () => {
    for (const [id, type] of Object.entries(TASK_TYPES)) {
      expect(type.id).toBe(id)
      expect(isTypeId(id)).toBe(true)
      expect(isLane(type.lane)).toBe(true)
      for (const c of type.capabilities) expect(CAPABILITIES).toContain(c)
    }
  })
})

describe("reminder", () => {
  it("says its text with done and snooze on offer", async () => {
    const outcome = await reminder.run?.(ctx())
    expect(outcome?.notify).toEqual({ text: "dentist", actions: ["done", "snooze"] })
    expect(outcome?.summary).toBe("dentist")
  })

  it("snoozes an hour by default, or as the reply asks", async () => {
    const reply = {
      id: "r1",
      taskId: "t1",
      occurrenceId: "o1",
      userId: "u1",
      kind: "snooze",
      payload: null,
      at: now.toISOString(),
    } as Reply
    const outcome = await reminder.onReply?.({ ...ctx(), reply })
    expect(outcome?.snoozeUntil?.toISOString()).toBe("2026-03-02T15:00:00.000Z")
    expect(snoozeUntil({ minutes: 15 }, now).toISOString()).toBe("2026-03-02T14:15:00.000Z")
    expect(snoozeUntil({ until: "2026-03-03T14:00:00.000Z" }, now).toISOString()).toBe(
      "2026-03-03T14:00:00.000Z",
    )
    expect(snoozeUntil({ until: "soon" }, now).toISOString()).toBe("2026-03-02T15:00:00.000Z")
  })

  it("records done without a follow-up", async () => {
    const reply = {
      id: "r2",
      taskId: "t1",
      occurrenceId: "o1",
      userId: "u1",
      kind: "done",
      payload: null,
      at: now.toISOString(),
    } as Reply
    expect(await reminder.onReply?.({ ...ctx(), reply })).toEqual({ summary: "done" })
  })
})
