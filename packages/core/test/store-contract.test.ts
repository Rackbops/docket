import { describe, expect, it } from "vitest"

import { MemoryStore, STORE_CONTRACT, type Store, StoreContractError } from "../src/index.js"

describe("the Store contract, on MemoryStore", () => {
  for (const c of STORE_CONTRACT) {
    it(c.name, async () => {
      await c.run(new MemoryStore())
    })
  }

  it("fails a store that breaks it, naming what differed", async () => {
    const leaky = new MemoryStore()
    const broken: Store = Object.assign(Object.create(leaky), {
      createOccurrence: (input: Parameters<Store["createOccurrence"]>[0]) =>
        leaky.createOccurrence({ ...input, dedupeKey: `${input.dedupeKey}:${Math.random()}` }),
    })
    const dedupe = STORE_CONTRACT.find((c) => c.name.includes("dedupe key"))
    await expect(dedupe?.run(broken)).rejects.toThrow(StoreContractError)
  })

  it("fails a store that never finds a block, which would switch off the decline rule", async () => {
    const leaky = new MemoryStore()
    const broken: Store = Object.assign(Object.create(leaky), { listBlocks: async () => [] })
    const blocks = STORE_CONTRACT.find((c) => c.name.startsWith("blocks"))
    await expect(blocks?.run(broken)).rejects.toThrow(StoreContractError)
  })

  it("fails a store whose ids carry a dot", async () => {
    const leaky = new MemoryStore()
    const broken: Store = Object.assign(Object.create(leaky), {
      createTask: async (input: Parameters<Store["createTask"]>[0]) => ({
        ...(await leaky.createTask(input)),
        id: "t.1",
      }),
    })
    const ids = STORE_CONTRACT.find((c) => c.name.startsWith("ids"))
    await expect(ids?.run(broken)).rejects.toThrow(StoreContractError)
  })

  it("fails a store that reads then writes, on each two-at-once case (docket#53)", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0))
    const racy = new MemoryStore()
    const broken: Store = Object.assign(Object.create(racy), {
      async updateOccurrenceIf(...args: Parameters<Store["updateOccurrenceIf"]>) {
        const [id, expected, patch] = args
        const cur = await racy.getOccurrence(id)
        await tick()
        if (!cur || cur.status !== expected) return null
        return racy.updateOccurrence(id, patch)
      },
      async createOccurrence(input: Parameters<Store["createOccurrence"]>[0]) {
        const all = await racy.listOccurrences({ taskId: input.taskId })
        await tick()
        if (all.some((o) => o.dedupeKey === input.dedupeKey)) return null
        return racy.createOccurrence({ ...input, dedupeKey: `${input.dedupeKey}:${Math.random()}` })
      },
      async claimNotice(key: string, at: string) {
        const seen = (racy as unknown as { seenNotice?: Set<string> }).seenNotice ?? new Set()
        ;(racy as unknown as { seenNotice: Set<string> }).seenNotice = seen
        const had = seen.has(key)
        await tick()
        seen.add(key)
        return had ? false : racy.claimNotice(`${key}:${at}:${Math.random()}`, at)
      },
    })
    for (const name of [
      "two starts of one run at once: exactly one wins",
      "two occurrences with one dedupe key at once: exactly one is created",
      "two claims of one notice key at once: exactly one wins",
    ]) {
      const c = STORE_CONTRACT.find((k) => k.name === name)
      await expect(c?.run(broken), name).rejects.toThrow(StoreContractError)
    }
  })

  it("fails a store whose settle ignores what it expects, or skips a pending row", async () => {
    const plain = new MemoryStore()
    const ignoring: Store = Object.assign(Object.create(plain), {
      settleDelivery: (...args: Parameters<Store["settleDelivery"]>) =>
        plain.settleDelivery(args[0], args[1], args[2]),
    })
    const stale = STORE_CONTRACT.find((c) => c.name.startsWith("a settle that expects"))
    await expect(stale?.run(ignoring)).rejects.toThrow(StoreContractError)
    const claimedOnly = new MemoryStore()
    const skipping: Store = Object.assign(Object.create(claimedOnly), {
      async settleDelivery(...args: Parameters<Store["settleDelivery"]>) {
        const [o, u] = args
        const cur = (await claimedOnly.listDeliveries({ occurrenceId: o, userId: u }))[0]
        if (cur?.status !== "claimed") return cur
        return claimedOnly.settleDelivery(...args)
      },
    })
    const pending = STORE_CONTRACT.find((c) => c.name.startsWith("a planned row"))
    await expect(pending?.run(skipping)).rejects.toThrow(StoreContractError)
  })
})
