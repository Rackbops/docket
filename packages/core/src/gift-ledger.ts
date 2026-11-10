import type { GiftSyncPlan } from "./gift-groups.js"
import type { GiftBase, GiftEvent, GiftFieldsByKind, GiftKind, GiftRecord } from "./gift-model.js"
import {
  type GiftEventFilter,
  type GiftListFilter,
  GiftNotFoundError,
  type GiftPatch,
  type GiftRequest,
  GiftRevisionError,
  type GiftStore,
  GiftValidationError,
  type GiftWriteMeta,
} from "./gift-ports.js"
import { allocationUnits, keptUnits } from "./gift-rules.js"
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
    case "occasion":
      return [
        ...many("group", "groupIds"),
        ...many("recipient", "includeIds"),
        ...many("recipient", "excludeIds"),
      ]
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
 * a guessed id reveals nothing. An archived record may still be pointed at: archiving hides a
 * record from lists, it never breaks a link to it.
 *
 * Two rules hold from both sides: a household's members are people (no recipient lists itself,
 * and a member stays a person), and an allocation's purchase is a purchase of the allocation's
 * item (an allocated purchase keeps its item). An idempotent retry is answered from the store
 * before anything is checked, so it gets the first result even after the records moved on, and
 * an update at a stale revision is refused as stale before its fields are judged.
 *
 * The reference checks read, then the store writes: they are not one atomic step with the write.
 * Two writes racing on the same records (a person becoming a household while a household adds
 * them) can both pass; a host that needs that closed serializes an owner's writes.
 * An allocation never holds more units than its purchase keeps (`checkFit`); coverage and spend
 * are derived in `gift-rules.ts`; rosters from groups in `gift-groups.ts`.
 */
export class GiftLedger {
  constructor(private readonly store: GiftStore) {}

  async create<K extends GiftKind>(
    kind: K,
    meta: GiftWriteMeta,
    fields: GiftFieldsByKind[K],
  ): Promise<GiftRecord<K>> {
    const replayed = await this.replayed(meta, { op: "create", kind, fields })
    if (replayed !== null) return replayed as GiftRecord<K>
    const problems = giftProblems(kind, fields)
    if (problems.length > 0) throw new GiftValidationError(problems)
    await this.checkRefs(kind, meta.ownerId, fields, null)
    await this.checkFit(kind, meta.ownerId, null, fields, false, null)
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
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new GiftValidationError(["a patch is an object of fields"])
    }
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as GiftPatch<K>
    const replayed = await this.replayed(meta, {
      op: "update",
      kind,
      id,
      expectedRevision,
      patch: clean,
    })
    if (replayed !== null) return replayed as GiftRecord<K>
    const current = await this.store.get(kind, meta.ownerId, id)
    if (current === null) throw new GiftNotFoundError(`no ${kind} ${id}`)
    // Stale: the store refuses it as stale; its fields are not judged against a newer record.
    if (current.revision !== expectedRevision) {
      return this.store.update(kind, id, meta, expectedRevision, clean)
    }
    const { archived, ...changes } = clean as GiftPatch<K> & { archived?: unknown }
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
    const {
      id: _pi,
      ownerId: _po,
      revision: _pr,
      createdAt: _pc,
      updatedAt: _pu,
      ...fieldChanges
    } = changes as typeof changes & Partial<GiftBase>
    const merged = { ...was, ...fieldChanges } as unknown as GiftFieldsByKind[K]
    const problems = giftProblems(kind, merged)
    if (problems.length > 0) throw new GiftValidationError(problems)
    await this.checkRefs(kind, meta.ownerId, merged, id)
    await this.checkReferrers(kind, meta.ownerId, id, current, merged)
    await this.checkFit(
      kind,
      meta.ownerId,
      id,
      merged,
      (archived as boolean | undefined) ?? current.archived,
      current,
    )
    return this.store.update(kind, id, meta, expectedRevision, clean)
  }

  /**
   * Writes a decided group sync (`planGroupSync`) through this ledger, so each write is checked
   * like any other. First it re-reads the occasion and its groups: an archived occasion, or one
   * of them moved since the preview, refuses the whole plan before anything is written. Then the
   * allocation changes (so a refused one leaves the roster as it was), new roster rows (planning,
   * no target or budget), restored rows and archived rows, each at the revision the preview
   * read. The writes are not one atomic step: one refused (a record moved on) leaves the earlier
   * ones written, and the owner previews again. With an idempotency key, write n uses
   * `<key>/<n>`, so retrying the same plan replays the writes already made and carries on; a new
   * preview needs a new key.
   */
  async applyGiftSync(meta: GiftWriteMeta, plan: GiftSyncPlan): Promise<void> {
    const occasion = await this.store.get("occasion", meta.ownerId, plan.occasionId)
    if (occasion === null) throw new GiftNotFoundError(`no occasion ${plan.occasionId}`)
    if (occasion.archived) {
      throw new GiftValidationError(["an archived occasion keeps its roster; it is never synced"])
    }
    const moved: string[] = []
    if (occasion.revision !== plan.occasionRevision) moved.push(`occasion ${occasion.id}`)
    for (const [id, revision] of Object.entries(plan.groupRevisions)) {
      const g = await this.store.get("group", meta.ownerId, id)
      if (g?.revision !== revision) moved.push(`group ${id}`)
    }
    if (moved.length > 0) {
      throw new GiftRevisionError(
        `changed since the preview: ${moved.join(", ")}`,
        occasion.revision,
      )
    }
    let n = 0
    const step = (): GiftWriteMeta => {
      n += 1
      const { idempotencyKey, ...rest } = meta
      return idempotencyKey === undefined
        ? rest
        : { ...rest, idempotencyKey: `${idempotencyKey}/${n}` }
    }
    for (const a of plan.allocations) {
      await this.update("allocation", a.id, step(), a.revision, a.patch)
    }
    for (const recipientId of plan.createRows) {
      await this.create("occasionRecipient", step(), {
        occasionId: plan.occasionId,
        recipientId,
        target: null,
        budgetMinor: null,
        decision: "planning",
        skipReason: null,
      })
    }
    for (const r of plan.restoreRows) {
      await this.update("occasionRecipient", r.id, step(), r.revision, { archived: false })
    }
    for (const r of plan.archiveRows) {
      await this.update("occasionRecipient", r.id, step(), r.revision, { archived: true })
    }
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

  private async replayed(meta: GiftWriteMeta, request: GiftRequest): Promise<GiftBase | null> {
    return meta.idempotencyKey === undefined ? null : this.store.replay(meta, request)
  }

  /**
   * The rules a record's referrers rely on, kept when the referred record changes: a person who
   * is a household's member stays a person, and a purchase an allocation names stays a purchase
   * of that allocation's item.
   */
  private async checkReferrers<K extends GiftKind>(
    kind: K,
    ownerId: string,
    id: string,
    was: GiftRecord<K>,
    next: GiftFieldsByKind[K],
  ): Promise<void> {
    if (kind === "recipient") {
      const before = was as GiftRecord<"recipient">
      const after = next as GiftFieldsByKind["recipient"]
      if (before.kind === "person" && after.kind !== "person") {
        const all = await this.store.list("recipient", ownerId, { includeArchived: true })
        if (all.some((r) => r.kind === "household" && r.memberIds.includes(id))) {
          throw new GiftValidationError([`${id} is a household's member, so it stays a person`])
        }
      }
    }
    if (kind === "purchase") {
      const before = was as GiftRecord<"purchase">
      const after = next as GiftFieldsByKind["purchase"]
      if (before.itemId !== after.itemId) {
        const all = await this.store.list("allocation", ownerId, { includeArchived: true })
        if (all.some((a) => a.purchaseId === id)) {
          throw new GiftValidationError([`purchase ${id} is allocated, so its item stays`])
        }
      }
    }
  }

  /**
   * A write never makes a purchase hold more units in live allocations than it keeps (ordered,
   * less cancelled and returned; an archived purchase keeps none). One allocation names one
   * occasion, so a unit is never on two. A later return or cancellation is not refused: it
   * reopens a gap (`giftBuckets`), and an allocation on that purchase stays editable as long as
   * the edit does not raise the units it holds there. Only allocation writes are checked: an edit
   * to the purchase (fewer ordered, archived) is never refused for the gifts on it.
   */
  private async checkFit<K extends GiftKind>(
    kind: K,
    ownerId: string,
    selfId: string | null,
    fields: GiftFieldsByKind[K],
    archived: boolean,
    was: GiftRecord<K> | null,
  ): Promise<void> {
    if (kind !== "allocation" || archived) return
    const a = fields as GiftFieldsByKind["allocation"]
    if (a.purchaseId === null) return
    const purchase = await this.store.get("purchase", ownerId, a.purchaseId)
    if (purchase === null) throw new GiftNotFoundError(`no purchase ${a.purchaseId}`)
    const others = await this.store.list("allocation", ownerId, { itemId: a.itemId })
    const held = others
      .filter((o) => o.purchaseId === a.purchaseId && o.id !== selfId)
      .reduce((n, o) => n + allocationUnits(o), 0)
    const kept = purchase.archived ? 0 : keptUnits(purchase)
    const prior = was as GiftRecord<"allocation"> | null
    const before =
      held +
      (prior !== null && !prior.archived && prior.purchaseId === a.purchaseId
        ? allocationUnits(prior)
        : 0)
    if (held + allocationUnits(a) > kept && held + allocationUnits(a) > before) {
      throw new GiftValidationError([
        `purchase ${a.purchaseId} keeps ${kept} units; this would allocate ${held + allocationUnits(a)}`,
      ])
    }
  }

  private async checkRefs<K extends GiftKind>(
    kind: K,
    ownerId: string,
    fields: GiftFieldsByKind[K],
    selfId: string | null,
  ): Promise<void> {
    for (const [refKind, refId] of refsOf(kind, fields)) {
      if (kind === "recipient" && refId === selfId) {
        throw new GiftValidationError([`${refId} cannot be its own member`])
      }
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
