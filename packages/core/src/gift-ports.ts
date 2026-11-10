import type {
  GiftEvent,
  GiftFieldsByKind,
  GiftKind,
  GiftRecord,
  GiftWriteSource,
} from "./gift-model.js"

/**
 * The gift ledger's storage port (plan item 158). Separate from `Store`, so a host that never
 * offers gifts implements nothing new. `MemoryGiftStore` is the reference; every adapter passes
 * `GIFT_STORE_CONTRACT`. A host writes through `GiftLedger`, which validates and checks
 * references before it calls this port.
 *
 * Every read and write names its owner, and a row of another owner's is answered exactly as a
 * missing one: `null` from `get`, absent from `list`, `GiftNotFoundError` from `update`.
 */
export interface GiftStore {
  /** Writes a new record at revision 1 and one event. */
  create<K extends GiftKind>(
    kind: K,
    meta: GiftWriteMeta,
    fields: GiftFieldsByKind[K],
  ): Promise<GiftRecord<K>>
  /**
   * Applies `patch` only while the stored revision equals `expectedRevision`, bumping it by one
   * and writing one event; otherwise `GiftRevisionError` and nothing changes. The check and the
   * write are one atomic step: two updates read at one revision, sent at once, have exactly one
   * winner.
   */
  update<K extends GiftKind>(
    kind: K,
    id: string,
    meta: GiftWriteMeta,
    expectedRevision: number,
    patch: GiftPatch<K>,
  ): Promise<GiftRecord<K>>
  get<K extends GiftKind>(kind: K, ownerId: string, id: string): Promise<GiftRecord<K> | null>
  /** In creation order. */
  list<K extends GiftKind>(
    kind: K,
    ownerId: string,
    filter?: GiftListFilter,
  ): Promise<GiftRecord<K>[]>
  /** In write order. */
  listEvents(ownerId: string, filter?: GiftEventFilter): Promise<GiftEvent[]>
  /** Erases every record, event and idempotency key of one owner (forget me). Returns rows erased. */
  forgetOwner(ownerId: string): Promise<number>
}

export interface GiftWriteMeta {
  ownerId: string
  actor: string
  source: GiftWriteSource
  at: string
  /**
   * When set, a write with the same owner, key and request returns the first result again and
   * writes nothing; the same key with another request is `GiftIdempotencyError`. Two writes with
   * one key sent at once produce one record.
   */
  idempotencyKey?: string
}

/** Fields to change. `archived: true` archives; there is no delete apart from `forgetOwner`. */
export type GiftPatch<K extends GiftKind> = Partial<GiftFieldsByKind[K]> & { archived?: boolean }

export interface GiftListFilter {
  includeArchived?: boolean
  /** For `occasionRecipient` and `allocation`. */
  occasionId?: string
  /** For `purchase` and `allocation`. */
  itemId?: string
}

export interface GiftEventFilter {
  kind?: GiftKind
  entityId?: string
}

/** A missing record, or one of another owner's. */
export class GiftNotFoundError extends Error {
  override name = "GiftNotFoundError"
}

/** The record moved on since the caller read it. */
export class GiftRevisionError extends Error {
  override name = "GiftRevisionError"
  constructor(
    message: string,
    readonly currentRevision: number,
  ) {
    super(message)
  }
}

/** An occasion already has this recipient on its roster. */
export class GiftDuplicateError extends Error {
  override name = "GiftDuplicateError"
}

/** An idempotency key reused for a different request. */
export class GiftIdempotencyError extends Error {
  override name = "GiftIdempotencyError"
}

/** Fields `GiftLedger` refuses, with every problem found. */
export class GiftValidationError extends Error {
  override name = "GiftValidationError"
  constructor(readonly problems: string[]) {
    super(problems.join("; "))
  }
}
