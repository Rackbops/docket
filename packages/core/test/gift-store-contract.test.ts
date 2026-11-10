import { describe, expect, it } from "vitest"

import {
  GIFT_STORE_CONTRACT,
  type GiftStore,
  GiftStoreContractError,
  MemoryGiftStore,
} from "../src/index.js"

function caseNamed(start: string) {
  const c = GIFT_STORE_CONTRACT.find((x) => x.name.startsWith(`gift: ${start}`))
  if (c === undefined) throw new Error(`no case starting ${start}`)
  return c
}

describe("the GiftStore contract, on MemoryGiftStore", () => {
  for (const c of GIFT_STORE_CONTRACT) {
    it(c.name, async () => {
      await c.run(new MemoryGiftStore())
    })
  }

  it("fails a store that skips the revision check", async () => {
    const real = new MemoryGiftStore()
    const broken: GiftStore = Object.assign(Object.create(real), {
      update: (async (kind, id, meta, _rev, patch) => {
        const current = await real.get(kind, meta.ownerId, id)
        return real.update(kind, id, meta, current?.revision ?? 0, patch)
      }) as GiftStore["update"],
    })
    await expect(caseNamed("a stale revision").run(broken)).rejects.toThrow(GiftStoreContractError)
  })

  it("fails a store that checks the revision and writes in two steps", async () => {
    const real = new MemoryGiftStore()
    const broken: GiftStore = Object.assign(Object.create(real), {
      update: (async (kind, id, meta, rev, patch) => {
        const read = await real.get(kind, meta.ownerId, id)
        if (read?.revision !== rev) return real.update(kind, id, meta, rev, patch)
        await new Promise((resolve) => setTimeout(resolve, 0))
        const now = await real.get(kind, meta.ownerId, id)
        return real.update(kind, id, meta, now?.revision ?? rev, patch)
      }) as GiftStore["update"],
    })
    await expect(caseNamed("two updates").run(broken)).rejects.toThrow(GiftStoreContractError)
  })

  it("fails a store whose get ignores the owner", async () => {
    const real = new MemoryGiftStore()
    const broken: GiftStore = Object.assign(Object.create(real), {
      get: (async (kind, _owner, id) => {
        for (const owner of ["owner-a", "owner-b"]) {
          const row = await real.get(kind, owner, id)
          if (row !== null) return row
        }
        return null
      }) as GiftStore["get"],
    })
    await expect(caseNamed("another owner's").run(broken)).rejects.toThrow(GiftStoreContractError)
  })

  it("fails a store that ignores idempotency keys", async () => {
    const real = new MemoryGiftStore()
    const broken: GiftStore = Object.assign(Object.create(real), {
      create: ((kind, meta, fields) => {
        const { idempotencyKey: _k, ...rest } = meta
        return real.create(kind, rest, fields)
      }) as GiftStore["create"],
    })
    await expect(caseNamed("a replayed create").run(broken)).rejects.toThrow(GiftStoreContractError)
    await expect(caseNamed("two creates").run(broken)).rejects.toThrow(GiftStoreContractError)
  })

  it("fails a store that keeps owners apart for recipients only", async () => {
    const real = new MemoryGiftStore()
    const broken: GiftStore = Object.assign(Object.create(real), {
      get: (async (kind, owner, id) => {
        if (kind === "recipient") return real.get(kind, owner, id)
        for (const o of ["owner-a", "owner-b"]) {
          const row = await real.get(kind, o, id)
          if (row !== null) return row
        }
        return null
      }) as GiftStore["get"],
    })
    await expect(caseNamed("another owner's").run(broken)).rejects.toThrow(GiftStoreContractError)
  })

  it("fails a store whose replay answers with the record as it is now", async () => {
    const real = new MemoryGiftStore()
    const broken: GiftStore = Object.assign(Object.create(real), {
      update: (async (kind, id, meta, rev, patch) => {
        const first = await real.replay(meta, {
          op: "update",
          kind,
          id,
          expectedRevision: rev,
          patch,
        })
        if (first !== null) return real.get(kind, meta.ownerId, id)
        return real.update(kind, id, meta, rev, patch)
      }) as GiftStore["update"],
    })
    await expect(caseNamed("a replay after the record moved on").run(broken)).rejects.toThrow(
      GiftStoreContractError,
    )
  })

  it("fails a store whose replay lookup forgets keys", async () => {
    const real = new MemoryGiftStore()
    const broken: GiftStore = Object.assign(Object.create(real), {
      replay: (async () => null) as GiftStore["replay"],
    })
    await expect(caseNamed("replay answers null").run(broken)).rejects.toThrow(
      GiftStoreContractError,
    )
  })

  it("fails a store that lets an occasion hold a recipient twice", async () => {
    const real = new MemoryGiftStore()
    let n = 0
    const broken: GiftStore = Object.assign(Object.create(real), {
      create: ((kind, meta, fields) => {
        if (kind !== "occasionRecipient") return real.create(kind, meta, fields)
        n += 1
        return real.create(kind, meta, { ...fields, recipientId: `${n}` } as typeof fields)
      }) as GiftStore["create"],
    })
    await expect(caseNamed("an occasion has a recipient once").run(broken)).rejects.toThrow(
      GiftStoreContractError,
    )
  })
})
