import {
  type Clock,
  type Fetch,
  type FetchResponse,
  Lanes,
  MemoryStore,
  type Notifier,
  type OutgoingMessage,
  type User,
} from "@rackbops/docket-core"

import { TASK_TYPES } from "../src/index.js"

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
}

/** Records every DM instead of sending one. */
export class FakeNotifier implements Notifier {
  readonly sent: Sent[] = []
  async sendDm(userId: string, message: OutgoingMessage): Promise<{ messageId: string }> {
    this.sent.push({ userId, message })
    return { messageId: `m${this.sent.length}` }
  }
}

/** Serves canned bodies by URL; anything else is a 404. */
export class FakeFetch implements Fetch {
  readonly requests: string[] = []
  constructor(private readonly pages: Record<string, string | FetchResponse> = {}) {}
  set(url: string, page: string | FetchResponse): void {
    this.pages[url] = page
  }
  async get(url: string): Promise<FetchResponse> {
    this.requests.push(url)
    const page = this.pages[url]
    if (page === undefined) return { status: 404, body: "", headers: {} }
    return typeof page === "string" ? { status: 200, body: page, headers: {} } : page
  }
}

export const T0 = "2026-03-02T12:00:00.000Z"

/** A store, a clock at T0, a notifier, an optional fetch, the shipped types, and one owner. */
export async function tracker(fetch?: FakeFetch): Promise<{
  store: MemoryStore
  clock: FakeClock
  notifier: FakeNotifier
  lanes: Lanes
  owner: User
}> {
  const store = new MemoryStore()
  const clock = new FakeClock(new Date(T0))
  const notifier = new FakeNotifier()
  const owner = await store.createUser({
    discordId: "d-larry",
    displayName: "Larry",
    timeZone: "America/New_York",
    preferredHour: 9,
    at: T0,
  })
  const lanes = new Lanes({
    store,
    clock,
    types: TASK_TYPES,
    notifier,
    executor: null,
    fetch: fetch ?? null,
  })
  return { store, clock, notifier, lanes, owner }
}

export function actor(user: User): { userId: string; admin: boolean } {
  return { userId: user.id, admin: user.admin }
}
