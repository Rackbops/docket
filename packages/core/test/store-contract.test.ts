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
})
