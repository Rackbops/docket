import type {
  GiftBase,
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
   * winner. The base fields (`id`, `ownerId`, `revision`, `createdAt`, `updatedAt`) in a patch are
   * ignored, and so is a key set to `undefined`. A refused write records no event.
   */
  update<K extends GiftKind>(
    kind: K,
    id: string,
    meta: GiftWriteMeta,
    expectedRevision: number,
    patch: GiftPatch<K>,
  ): Promise<GiftRecord<K>>
  get<K extends GiftKind>(kind: K, ownerId: string, id: string): Promise<GiftRecord<K> | null>
  /**
   * In creation order: the order the rows were written, not a sort on `createdAt`, which many rows
   * can share.
   */
  list<K extends GiftKind>(
    kind: K,
    ownerId: string,
    filter?: GiftListFilter,
  ): Promise<GiftRecord<K>[]>
  /**
   * The result the first write with this owner and key got, or null when the key is unused;
   * `GiftIdempotencyError` when the key was used for another request. It writes nothing.
   * `GiftLedger` asks before it validates, so a replay is answered as the first write was even
   * after the record moved on; `create` and `update` replay the same way on their own.
   */
  replay(meta: GiftWriteMeta, request: GiftRequest): Promise<GiftBase | null>
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

/** One write, as an idempotency key remembers it. */
export type GiftRequest =
  | { op: "create"; kind: GiftKind; fields: unknown }
  | { op: "update"; kind: GiftKind; id: string; expectedRevision: number; patch: unknown }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonical(v)
    }
    return out
  }
  return value
}

/**
 * A request's identity for idempotency: the same write gives the same string whatever the order
 * of its keys, and a key set to `undefined` counts as absent. A host stores this beside the key.
 */
export function giftRequestKey(request: GiftRequest): string {
  return JSON.stringify(canonical(request))
}

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

/**
 * An occasion already has this recipient on its roster. An archived roster row still holds its
 * place: restore it rather than adding the recipient again.
 */
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
