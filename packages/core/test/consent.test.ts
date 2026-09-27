import { describe, expect, it } from "vitest"

import {
  createTask,
  DECLINE_BLOCK_MS,
  invite,
  liftBlock,
  optOut,
  respondToInvite,
} from "../src/index.js"
import { actor, FakeClock, MemoryStore, people, T0 } from "./helpers.js"

const type = {
  id: "reminder",
  lane: "notify" as const,
  capabilities: ["notify" as const],
  schedule: ["once" as const],
  run: async () => ({}),
}

async function setup() {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const folks = await people(store)
  const { task } = await createTask(
    store,
    actor(folks.larry),
    folks.larry,
    { type, title: "t", config: {}, schedule: null },
    clock.now(),
  )
  return { store, clock, task, ...folks }
}

describe("the decline rule", () => {
  it("blocks the owner's invitations for 24 hours after a decline", async () => {
    const { store, clock, task, larry, moe } = await setup()
    expect((await invite(store, actor(larry), task, moe.id, clock.now())).ok).toBe(true)
    const declined = await respondToInvite(store, task, moe.id, "decline", clock.now())
    expect(declined.block?.expiresAt).toBe(
      new Date(clock.now().getTime() + DECLINE_BLOCK_MS).toISOString(),
    )

    clock.advance(DECLINE_BLOCK_MS - 1)
    const again = await invite(store, actor(larry), task, moe.id, clock.now())
    expect(again).toMatchObject({ ok: false, reason: "blocked" })

    clock.advance(2)
    expect((await invite(store, actor(larry), task, moe.id, clock.now())).ok).toBe(true)
  })

  it("makes a second decline permanent until an admin lifts it", async () => {
    const { store, clock, task, larry, moe, admin } = await setup()
    await invite(store, actor(larry), task, moe.id, clock.now())
    await respondToInvite(store, task, moe.id, "decline", clock.now())
    clock.advance(DECLINE_BLOCK_MS + 1)
    await invite(store, actor(larry), task, moe.id, clock.now())
    const second = await respondToInvite(store, task, moe.id, "decline", clock.now())
    expect(second.block?.expiresAt).toBeNull()

    clock.advance(DECLINE_BLOCK_MS * 400)
    const blocked = await invite(store, actor(larry), task, moe.id, clock.now())
    expect(blocked).toMatchObject({ ok: false, reason: "blocked" })

    const blockId = second.block?.id ?? ""
    await expect(liftBlock(store, actor(larry), blockId, clock.now())).rejects.toThrow(/admin/)
    const lifted = await liftBlock(store, actor(admin), blockId, clock.now())
    expect(lifted.liftedBy).toBe(admin.id)
    expect((await invite(store, actor(larry), task, moe.id, clock.now())).ok).toBe(true)
  })

  it("treats an opt-out from an accepted task as no decline", async () => {
    const { store, clock, task, larry, moe } = await setup()
    await invite(store, actor(larry), task, moe.id, clock.now())
    await respondToInvite(store, task, moe.id, "accept", clock.now())
    await optOut(store, task, moe.id, clock.now())
    expect(await store.listBlocks(larry.id, moe.id)).toEqual([])
    expect((await store.listRecipients(task.id))[0]?.state).toBe("opted_out")
    expect((await invite(store, actor(larry), task, moe.id, clock.now())).ok).toBe(true)
  })

  it("lets only the owner or an admin invite, and never the owner themselves", async () => {
    const { store, clock, task, larry, moe, curly, admin } = await setup()
    expect(await invite(store, actor(moe), task, curly.id, clock.now())).toMatchObject({
      ok: false,
      reason: "not_owner",
    })
    expect(await invite(store, actor(larry), task, larry.id, clock.now())).toMatchObject({
      ok: false,
      reason: "self",
    })
    expect((await invite(store, actor(admin), task, curly.id, clock.now())).ok).toBe(true)
    expect(await invite(store, actor(larry), task, curly.id, clock.now())).toMatchObject({
      ok: false,
      reason: "already_invited",
    })
  })
})
