import type { Clock, Notifier, OutgoingMessage, User } from "../src/index.js"
import { MemoryStore } from "../src/index.js"

/** A clock the test moves by hand. */
export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current)
  }
  set(to: Date | string): void {
    this.current = new Date(to)
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
}

export interface Sent {
  userId: string
  message: OutgoingMessage
  messageId: string
}

/** Records every DM instead of sending one. */
export class FakeNotifier implements Notifier {
  readonly sent: Sent[] = []
  async sendDm(userId: string, message: OutgoingMessage): Promise<{ messageId: string }> {
    const messageId = `m${this.sent.length + 1}`
    this.sent.push({ userId, message, messageId })
    return { messageId }
  }
}

export const T0 = "2026-03-02T12:00:00.000Z"

export async function people(
  store: MemoryStore,
  at = T0,
): Promise<{ larry: User; moe: User; curly: User; admin: User }> {
  const zone = "America/New_York"
  const larry = await store.createUser({
    discordId: "d-larry",
    displayName: "Larry",
    timeZone: zone,
    preferredHour: 9,
    at,
  })
  const moe = await store.createUser({
    discordId: "d-moe",
    displayName: "Moe",
    timeZone: zone,
    preferredHour: 9,
    at,
  })
  const curly = await store.createUser({
    discordId: "d-curly",
    displayName: "Curly",
    timeZone: zone,
    preferredHour: 9,
    at,
  })
  const admin = await store.createUser({
    discordId: "d-admin",
    displayName: "Admin",
    timeZone: zone,
    preferredHour: 9,
    admin: true,
    at,
  })
  return { larry, moe, curly, admin }
}

export function actor(user: User): { userId: string; admin: boolean } {
  return { userId: user.id, admin: user.admin }
}

export { MemoryStore }
