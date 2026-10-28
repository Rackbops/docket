import { describe, expect, it } from "vitest"

import { AUTH_RETRY_MS, MAX_TRIES, RETRIED, retryOutcome } from "../src/index.js"

const NOW = new Date("2026-03-02T12:00:00.000Z")

describe("retryOutcome (docket#67)", () => {
  it("retries a retried kind at once, while tries remain", () => {
    for (const kind of ["schema_miss", "malformed", "timeout", "error"] as const) {
      expect(RETRIED.has(kind)).toBe(true)
      expect(retryOutcome(kind, 1, NOW)).toEqual({ at: NOW.toISOString(), followUp: {} })
      expect(retryOutcome(kind, MAX_TRIES, NOW)).toBeNull()
    }
  })

  it("waits an hour after an auth failure", () => {
    const at = new Date(NOW.getTime() + AUTH_RETRY_MS).toISOString()
    expect(retryOutcome("auth_failed", 1, NOW)).toEqual({ at, followUp: { at } })
  })

  it("never retries a cap or a usage limit", () => {
    for (const kind of ["turn_cap", "budget_cap", "usage_limit"] as const) {
      expect(retryOutcome(kind, 1, NOW)).toBeNull()
    }
  })
})
