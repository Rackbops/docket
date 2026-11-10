import type { GiftEvent, GiftFieldsByKind, GiftKind, GiftRecord } from "./gift-model.js"
import {
  type GiftEventFilter,
  type GiftListFilter,
  GiftNotFoundError,
  type GiftPatch,
  type GiftStore,
  GiftValidationError,
  type GiftWriteMeta,
} from "./gift-ports.js"
import { giftProblems } from "./gift-validate.js"

/** The ids one record points at, by the kind each must be. */
type Refs = [GiftKind, string][]

function refsOf<K extends GiftKind>(kind: K, fields: GiftFieldsByKind[K]): Refs {
  const f = fields as unknown as Record<string, unknown>
  const one = (k: GiftKind, name: string): Refs =>
    typeof f[name] === "string" ? [[k, f[name] as string]] : []
  const many = (k: GiftKind, name: string): Refs =>
    Array.isArray(f[name]) ? (f[name] as string[]).map((id) => [k, id]) : []
  switch (kind) {
    case "recipient":
    case "group":
      return many("recipient", "memberIds")
    case "occasionRecipient":
      return [...one("occasion", "occasionId"), ...one("recipient", "recipientId")]
    case "purchase":
      return one("item", "itemId")
    case "allocation":
      return [
        ...one("item", "itemId"),
        ...one("occasion", "occasionId"),
        ...many("recipient", "recipientIds"),
        ...one("purchase", "purchaseId"),
      ]
    default:
      return []
  }
}

/**
 * The gift ledger's one write path (plan item 158): every write is validated, and every id it
 * points at must be the same owner's record of the right kind, or it is refused as not found, so
 * a guessed id reveals nothing. A household's members are people; an allocation's purchase is a
 * purchase of the same item. Coverage, allocation limits and spend are docket#96; groups and
 * occasion snapshots docket#97.
 */
export class GiftLedger {
  constructor(private readonly store: GiftStore) {}

  async create<K extends GiftKind>(
    kind: K,
    meta: GiftWriteMeta,
    fields: GiftFieldsByKind[K],
  ): Promise<GiftRecord<K>> {
    const problems = giftProblems(kind, fields)
    if (problems.length > 0) throw new GiftValidationError(problems)
    await this.checkRefs(kind, meta.ownerId, fields)
    return this.store.create(kind, meta, fields)
  }

  /**
   * Changes the named fields of a record the caller read at `expectedRevision`. The result is
   * checked whole, as a create would be. `archived` archives or restores; nothing is deleted.
   */
  async update<K extends GiftKind>(
    kind: K,
    id: string,
    meta: GiftWriteMeta,
    expectedRevision: number,
    patch: GiftPatch<K>,
  ): Promise<GiftRecord<K>> {
    const current = await this.store.get(kind, meta.ownerId, id)
    if (current === null) throw new GiftNotFoundError(`no ${kind} ${id}`)
    const { archived, ...changes } = patch as GiftPatch<K> & { archived?: unknown }
    if (archived !== undefined && typeof archived !== "boolean") {
      throw new GiftValidationError(["archived must be true or false"])
    }
    const {
      id: _i,
      ownerId: _o,
      revision: _r,
      archived: _a,
      createdAt: _c,
      updatedAt: _u,
      ...was
    } = current
    const merged = { ...was, ...changes } as unknown as GiftFieldsByKind[K]
    const problems = giftProblems(kind, merged)
    if (problems.length > 0) throw new GiftValidationError(problems)
    await this.checkRefs(kind, meta.ownerId, merged)
    return this.store.update(kind, id, meta, expectedRevision, patch)
  }

  get<K extends GiftKind>(kind: K, ownerId: string, id: string): Promise<GiftRecord<K> | null> {
    return this.store.get(kind, ownerId, id)
  }

  list<K extends GiftKind>(
    kind: K,
    ownerId: string,
    filter?: GiftListFilter,
  ): Promise<GiftRecord<K>[]> {
    return this.store.list(kind, ownerId, filter)
  }

  history(ownerId: string, filter?: GiftEventFilter): Promise<GiftEvent[]> {
    return this.store.listEvents(ownerId, filter)
  }

  private async checkRefs<K extends GiftKind>(
    kind: K,
    ownerId: string,
    fields: GiftFieldsByKind[K],
  ): Promise<void> {
    for (const [refKind, refId] of refsOf(kind, fields)) {
      const row = await this.store.get(refKind, ownerId, refId)
      if (row === null) throw new GiftNotFoundError(`no ${refKind} ${refId}`)
      if (kind === "recipient" && (row as GiftRecord<"recipient">).kind !== "person") {
        throw new GiftValidationError([`household member ${refId} must be a person`])
      }
      if (
        kind === "allocation" &&
        refKind === "purchase" &&
        (row as GiftRecord<"purchase">).itemId !== (fields as GiftFieldsByKind["allocation"]).itemId
      ) {
        throw new GiftValidationError([`purchase ${refId} is for another item`])
      }
    }
  }
}
