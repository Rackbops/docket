import { describe, expect, it } from "vitest"

import {
  ADMIN_DISCLOSURE,
  createTask,
  formatTaskList,
  invite,
  inviteMessage,
  registrationText,
  respondToInvite,
  type Schedule,
  type TaskType,
  taskList,
  type User,
} from "../src/index.js"
import { actor, FakeClock, MemoryStore, people, T0 } from "./helpers.js"

const reminder: TaskType<{ text: string }> = {
  id: "reminder",
  lane: "notify",
  capabilities: ["notify"],
  schedule: ["once", "calendar"],
  run: async () => ({}),
}

async function setup() {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const folks = await people(store)
  const daily: Schedule = { kind: "calendar", every: 1, unit: "day", start: "2026-03-02" }
  const make = (owner: User, title: string, schedule: Schedule | null) =>
    createTask(
      store,
      actor(owner),
      owner,
      { type: reminder, title, config: { text: title }, schedule },
      clock.now(),
    )
  return { store, clock, daily, make, ...folks }
}

describe("the consent DM", () => {
  it("says who, what, how often, that they only receive, and that an admin can see it", async () => {
    const { make, daily, larry, moe } = await setup()
    const { task } = await make(larry, "Water the plants", daily)
    const message = inviteMessage(task, larry, { ...moe, timeZone: "Europe/London" })
    expect(message.text).toBe(
      [
        'Larry wants you to be notified about "Water the plants", which runs daily at 9:00 (America/New_York time).',
        "You would only receive its results; you can stop them from any message.",
        ADMIN_DISCLOSURE,
        "Do you accept these notifications?",
      ].join("\n"),
    )
    expect(message.actions).toEqual(["accept", "decline"])
    expect(message.ref).toEqual({ taskId: task.id, occurrenceId: null })
  })

  it("puts the disclosure in the registration reply too", () => {
    const text = registrationText("https://usr.example/r/abc")
    expect(text).toContain("https://usr.example/r/abc")
    expect(text).toContain(ADMIN_DISCLOSURE)
  })
})

describe("the task list", () => {
  it("lists own and accepted tasks, soonest first, never others' for an admin", async () => {
    const { store, clock, make, daily, larry, moe, admin } = await setup()
    await make(larry, "Water the plants", daily)
    const { task: shared } = await make(moe, "Trash day", {
      kind: "calendar",
      every: 1,
      unit: "week",
      hour: 7,
      start: "2026-03-02",
    })
    await make(larry, "Someday", null)
    await make(admin, "Admin's own", null)
    await invite(store, actor(moe), shared, larry.id, clock.now())
    await respondToInvite(store, shared, larry.id, "accept", clock.now())

    const entries = await taskList(store, actor(larry))
    expect(entries.map((e) => e.task.title)).toEqual(["Water the plants", "Trash day", "Someday"])
    expect(formatTaskList(entries, larry, clock.now())).toBe(
      [
        `\`${entries[0]?.task.id}\` Water the plants -- next Mon Mar 2, 9:00, daily at 9:00`,
        `\`${shared.id}\` Trash day (from Moe) -- next Mon Mar 9, 7:00, weekly on Mon at 7:00`,
        `\`${entries[2]?.task.id}\` Someday -- nothing due`,
      ].join("\n"),
    )
    expect((await taskList(store, actor(admin))).map((e) => e.task.title)).toEqual(["Admin's own"])
    expect(formatTaskList([], larry, clock.now())).toBe("You have no active tasks.")
  })
})
