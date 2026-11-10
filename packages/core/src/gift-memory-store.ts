import type { GiftBase, GiftEvent, GiftFieldsByKind, GiftKind, GiftRecord } from "./gift-model.js"
import {
  GiftDuplicateError,
  type GiftEventFilter,
  GiftIdempotencyError,
  type GiftListFilter,
  GiftNotFoundError,
  type GiftPatch,
  GiftRevisionError,
  type GiftStore,
  type GiftWriteMeta,
} from "./gift-ports.js"

const PREFIX: Record<GiftKind, string> = {
  recipient: "gr",
  group: "gg",
  occasion: "go",
  occasionRecipient: "gor",
  item: "gi",
  purchase: "gp",
  allocation: "ga",
}

interface Remembered {
  request: string
  result: GiftBase
}

/**
 * The GiftStore port in memory: the reference semantics every host adapter must keep, and the
 * fake the tests run on. Every check-and-write runs with no `await` in between, so it is atomic
 * the way one SQLite transaction is. Ids are `<prefix><n>`; every read returns a copy.
 */
export class MemoryGiftStore implements GiftStore {
  private readonly rows = new Map<string, { kind: GiftKind; row: GiftBase }>()
  private readonly events: GiftEvent[] = []
  private readonly keys = new Map<string, Remembered>()
  private seq = 0

  private next(prefix: string): string {
    this.seq += 1
    return `${prefix}${this.seq}`
  }

  private static copy<T>(value: T): T {
    return structuredClone(value)
  }

  /** The remembered result for a key, or undefined; throws when the key named another request. */
  private replay(meta: GiftWriteMeta, request: string): GiftBase | undefined {
    if (meta.idempotencyKey === undefined) return undefined
    const seen = this.keys.get(`${meta.ownerId}\u0000${meta.idempotencyKey}`)
    if (seen === undefined) return undefined
    if (seen.request !== request) {
      throw new GiftIdempotencyError(`idempotency key reused for another request`)
    }
    return MemoryGiftStore.copy(seen.result)
  }

  private remember(meta: GiftWriteMeta, request: string, result: GiftBase): void {
    if (meta.idempotencyKey === undefined) return
    this.keys.set(`${meta.ownerId}\u0000${meta.idempotencyKey}`, {
      request,
      result: MemoryGiftStore.copy(result),
    })
  }

  private checkPair(ownerId: string, row: GiftBase, selfId: string | null): void {
    const pair = row as unknown as GiftRecord<"occasionRecipient">
    for (const { kind, row: other } of this.rows.values()) {
      if (kind !== "occasionRecipient" || other.ownerId !== ownerId || other.id === selfId) continue
      const o = other as GiftRecord<"occasionRecipient">
      if (o.occasionId === pair.occasionId && o.recipientId === pair.recipientId) {
        throw new GiftDuplicateError("that recipient is already on this occasion")
      }
    }
  }

  private log(kind: GiftKind, meta: GiftWriteMeta, prior: GiftBase | null, next: GiftBase): void {
    this.events.push({
      id: this.next("gev"),
      ownerId: meta.ownerId,
      kind,
      entityId: next.id,
      actor: meta.actor,
      source: meta.source,
      at: meta.at,
      prior: MemoryGiftStore.copy(prior),
      next: MemoryGiftStore.copy(next),
    })
  }

  async create<K extends GiftKind>(
    kind: K,
    meta: GiftWriteMeta,
    fields: GiftFieldsByKind[K],
  ): Promise<GiftRecord<K>> {
    const request = JSON.stringify(["create", kind, fields])
    const replayed = this.replay(meta, request)
    if (replayed !== undefined) return replayed as GiftRecord<K>
    const row = {
      ...MemoryGiftStore.copy(fields),
      id: this.next(PREFIX[kind]),
      ownerId: meta.ownerId,
      revision: 1,
      archived: false,
      createdAt: meta.at,
      updatedAt: meta.at,
    } as GiftRecord<K>
    if (kind === "occasionRecipient") this.checkPair(meta.ownerId, row, null)
    this.rows.set(row.id, { kind, row })
    this.log(kind, meta, null, row)
    this.remember(meta, request, row)
    return MemoryGiftStore.copy(row)
  }

  async update<K extends GiftKind>(
    kind: K,
    id: string,
    meta: GiftWriteMeta,
    expectedRevision: number,
    patch: GiftPatch<K>,
  ): Promise<GiftRecord<K>> {
    const request = JSON.stringify(["update", kind, id, expectedRevision, patch])
    const replayed = this.replay(meta, request)
    if (replayed !== undefined) return replayed as GiftRecord<K>
    const found = this.rows.get(id)
    if (found === undefined || found.kind !== kind || found.row.ownerId !== meta.ownerId) {
      throw new GiftNotFoundError(`no ${kind} ${id}`)
    }
    const prior = found.row
    if (prior.revision !== expectedRevision) {
      throw new GiftRevisionError(
        `${kind} ${id} is at revision ${prior.revision}, not ${expectedRevision}`,
        prior.revision,
      )
    }
    const {
      id: _i,
      ownerId: _o,
      revision: _r,
      createdAt: _c,
      updatedAt: _u,
      ...allowed
    } = patch as GiftPatch<K> & Partial<GiftBase>
    const next = {
      ...MemoryGiftStore.copy(prior),
      ...MemoryGiftStore.copy(allowed),
      revision: prior.revision + 1,
      updatedAt: meta.at,
    } as GiftRecord<K>
    if (kind === "occasionRecipient") this.checkPair(meta.ownerId, next, id)
    this.rows.set(id, { kind, row: next })
    this.log(kind, meta, prior, next)
    this.remember(meta, request, next)
    return MemoryGiftStore.copy(next)
  }

  async get<K extends GiftKind>(
    kind: K,
    ownerId: string,
    id: string,
  ): Promise<GiftRecord<K> | null> {
    const found = this.rows.get(id)
    if (found === undefined || found.kind !== kind || found.row.ownerId !== ownerId) return null
    return MemoryGiftStore.copy(found.row) as GiftRecord<K>
  }

  async list<K extends GiftKind>(
    kind: K,
    ownerId: string,
    filter: GiftListFilter = {},
  ): Promise<GiftRecord<K>[]> {
    const out: GiftRecord<K>[] = []
    for (const found of this.rows.values()) {
      if (found.kind !== kind || found.row.ownerId !== ownerId) continue
      const row = found.row as GiftRecord<K> & { occasionId?: string; itemId?: string }
      if (row.archived && filter.includeArchived !== true) continue
      if (filter.occasionId !== undefined && row.occasionId !== filter.occasionId) continue
      if (filter.itemId !== undefined && row.itemId !== filter.itemId) continue
      out.push(MemoryGiftStore.copy(row))
    }
    return out
  }

  async listEvents(ownerId: string, filter: GiftEventFilter = {}): Promise<GiftEvent[]> {
    return MemoryGiftStore.copy(
      this.events.filter(
        (e) =>
          e.ownerId === ownerId &&
          (filter.kind === undefined || e.kind === filter.kind) &&
          (filter.entityId === undefined || e.entityId === filter.entityId),
      ),
    )
  }

  async forgetOwner(ownerId: string): Promise<number> {
    let erased = 0
    for (const [id, found] of this.rows) {
      if (found.row.ownerId === ownerId) {
        this.rows.delete(id)
        erased += 1
      }
    }
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      if (this.events[i]?.ownerId === ownerId) {
        this.events.splice(i, 1)
        erased += 1
      }
    }
    for (const key of this.keys.keys()) {
      if (key.startsWith(`${ownerId}\u0000`)) this.keys.delete(key)
    }
    return erased
  }
}
