import {
  findGiftDuplicates,
  type GiftDuplicateInput,
  type GiftDuplicateReport,
} from "./gift-duplicates.js"
import { type GiftSyncPlan, previewRoster, resolveGroups, rosterIds } from "./gift-groups.js"
import {
  applyGiftImportRows,
  type GiftImportApplyOptions,
  type GiftImportOutcome,
  type GiftImportReviewed,
} from "./gift-import.js"
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
import { type GiftRolloverPreview, previewGiftRollover } from "./gift-rollover.js"
import { allocationUnits, keptUnits } from "./gift-rules.js"
import { type GiftIdeaChoice, giftIdeaFromFinding, giftWatchProblems } from "./gift-scout.js"
import { giftProblems } from "./gift-validate.js"
import type { StoredFinding, Task } from "./model.js"

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
        ...many("allocation", "repeatOf"),
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
    const repeats = (merged as { repeatOf?: unknown }).repeatOf
    if (kind === "allocation" && Array.isArray(repeats) && repeats.includes(id)) {
      throw new GiftValidationError([`allocation ${id} cannot repeat itself`])
    }
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
   * "Save as gift idea" (docket#101): one of the owner's findings, as the host read it from its
   * task `Store`, made a new item in the `idea` state (`giftIdeaFromFinding`), linked back to it.
   * It allocates nothing, so it covers nobody, and it never touches the finding or its task.
   * Another owner's finding is refused as not found. Without an idempotency key, a finding a live
   * (unarchived, rejected or not) item is already linked to is refused (`GiftValidationError`), so
   * a double save makes one idea; with a key, a retry replays, and a new key is a new save. The
   * check reads, then the store writes: two saves racing can both pass.
   */
  async saveFindingAsIdea(
    meta: GiftWriteMeta,
    finding: StoredFinding,
    choice: GiftIdeaChoice = {},
  ): Promise<GiftRecord<"item">> {
    if (finding.ownerId !== meta.ownerId) throw new GiftNotFoundError(`no finding ${finding.id}`)
    const fields = giftIdeaFromFinding(finding, choice)
    if (meta.idempotencyKey === undefined) {
      const live = await this.store.list("item", meta.ownerId)
      const ref = fields.source.ref
      if (live.some((i) => i.source.kind === "scout" && i.source.ref === ref)) {
        throw new GiftValidationError([`finding ${finding.id} is already saved as a gift idea`])
      }
    }
    return this.create("item", meta, fields)
  }

  /**
   * Sets the watches a gift follows (`watchTaskIds`, docket#101), refusing
   * (`GiftValidationError`) any that `giftWatchProblems` refuses against `tasks`, the host's read
   * of the owner's tasks. The gift store cannot see tasks, so this is the checked way to link;
   * it writes only the item, never a task.
   */
  async linkGiftWatches(
    meta: GiftWriteMeta,
    itemId: string,
    expectedRevision: number,
    watchTaskIds: string[],
    tasks: readonly Pick<Task, "id" | "ownerId" | "type">[],
  ): Promise<GiftRecord<"item">> {
    const problems = giftWatchProblems(meta.ownerId, watchTaskIds, tasks)
    if (problems.length > 0) throw new GiftValidationError(problems)
    return this.update("item", itemId, meta, expectedRevision, { watchTaskIds })
  }

  /**
   * The duplicate warnings and possible duplicates for an allocation about to be written
   * (`findGiftDuplicates`, docket#100), read from the store. It writes nothing, and refuses only
   * an item that is not the owner's (not found); a warning never refuses: the host shows the
   * report, and an allocation the owner writes anyway carries the warned ids in `repeatOf`.
   */
  async giftDuplicates(
    ownerId: string,
    allocation: GiftDuplicateInput["allocation"],
  ): Promise<GiftDuplicateReport> {
    if ((await this.store.get("item", ownerId, allocation.itemId)) === null) {
      throw new GiftNotFoundError(`no item ${allocation.itemId}`)
    }
    const all = { includeArchived: true }
    return findGiftDuplicates({
      allocation,
      items: await this.store.list("item", ownerId, all),
      allocations: await this.store.list("allocation", ownerId, all),
      occasions: await this.store.list("occasion", ownerId, all),
      purchases: await this.store.list("purchase", ownerId, all),
      recipients: await this.store.list("recipient", ownerId, all),
    })
  }

  /**
   * Makes a reviewed "set up next year" (`previewGiftRollover`, docket#99): the new occasion, its
   * roster rows (planning, with each staying person's target and budget) and the picked ideas as
   * new, unbought gifts, each with `repeatOf` naming the gift it came from. It first previews again
   * from the store with the same picks, title and date, and refuses (`GiftRevisionError`) before
   * anything is written when what it would write differs: the old occasion's or a group's revision
   * moved, or the new occasion, the roster (who, with what target and budget) or a picked idea (its
   * people, quantity or sharing) came out different. Order and key order do not count for the
   * check; a gift bought or added that was not picked does not either. A picked gift's item that is
   * gone, archived or rejected is refused the same way (unpick it). The old occasion is never
   * written. Not atomic: a refused write leaves the earlier ones (preview again). With an
   * idempotency key, write n uses `<key>/<n>`, so retrying replays what was made; the check runs
   * first, so a retry after something moved is refused, not replayed. Without a key, a live
   * occasion other than the old one with the same kind, title, year and date refuses it
   * (`GiftValidationError`), so a lost answer retried does not make a second one. So an occasion
   * with no date and no year, rolled over again while an earlier copy is still live, needs a key
   * (or that copy archived).
   */
  async applyGiftRollover(
    meta: GiftWriteMeta,
    preview: GiftRolloverPreview,
  ): Promise<GiftRecord<"occasion">> {
    const old = await this.store.get("occasion", meta.ownerId, preview.fromOccasionId)
    if (old === null) throw new GiftNotFoundError(`no occasion ${preview.fromOccasionId}`)
    const all = { includeArchived: true }
    let now: GiftRolloverPreview
    try {
      now = previewGiftRollover({
        occasion: old,
        groups: await this.store.list("group", meta.ownerId, all),
        recipients: await this.store.list("recipient", meta.ownerId, all),
        roster: await this.store.list("occasionRecipient", meta.ownerId, {
          ...all,
          occasionId: old.id,
        }),
        allocations: await this.store.list("allocation", meta.ownerId, {
          ...all,
          occasionId: old.id,
        }),
        pick: preview.ideas.map((i) => i.fromAllocationId),
        title: preview.occasion.title,
        date: preview.occasion.date,
      })
    } catch (err) {
      // What the preview picked cannot be picked now (a person archived, a gift bought): moved.
      if (!(err instanceof GiftValidationError)) throw err
      throw new GiftRevisionError(
        `occasion ${old.id} moved since the preview (${err.problems.join("; ")}); preview again`,
        old.revision,
      )
    }
    if (rolloverKey(now) !== rolloverKey(preview)) {
      throw new GiftRevisionError(
        `occasion ${old.id}, its groups, people or gifts changed since the preview; preview again`,
        old.revision,
      )
    }
    for (const idea of preview.ideas) {
      const it = await this.store.get("item", meta.ownerId, idea.itemId)
      if (it === null || it.archived || it.planning === "rejected") {
        throw new GiftRevisionError(
          `item ${idea.itemId} is gone, archived or rejected; unpick it and preview again`,
          old.revision,
        )
      }
    }
    if (meta.idempotencyKey === undefined) {
      const live = await this.store.list("occasion", meta.ownerId)
      const o = preview.occasion
      const same = (x: GiftRecord<"occasion">) =>
        x.id !== preview.fromOccasionId &&
        x.kind === o.kind &&
        x.title === o.title &&
        x.year === o.year &&
        x.date === o.date
      if (live.some(same)) {
        throw new GiftValidationError([
          `a live ${o.kind} occasion "${o.title}" already exists: this rollover may have been made (archive it, or pass an idempotency key)`,
        ])
      }
    }
    let n = 0
    const step = (): GiftWriteMeta => {
      n += 1
      const { idempotencyKey, ...rest } = meta
      return idempotencyKey === undefined
        ? rest
        : { ...rest, idempotencyKey: `${idempotencyKey}/${n}` }
    }
    const made = await this.create("occasion", step(), preview.occasion)
    for (const r of preview.roster) {
      await this.create("occasionRecipient", step(), {
        occasionId: made.id,
        recipientId: r.recipientId,
        target: r.target,
        budgetMinor: r.budgetMinor,
        decision: "planning",
        skipReason: null,
      })
    }
    for (const idea of preview.ideas) {
      await this.create("allocation", step(), {
        itemId: idea.itemId,
        occasionId: made.id,
        recipientIds: idea.recipientIds,
        quantity: idea.quantity,
        shared: idea.shared,
        purchaseId: null,
        handoff: "none",
        givenOn: null,
        // The same idea again on purpose: a warning against its source reads as accepted.
        repeatOf: [idea.fromAllocationId],
      })
    }
    return made
  }

  /**
   * Writes a decided group sync (`planGroupSync`) through this ledger, so each write is checked
   * like any other. First it re-reads the occasion and its groups: an archived occasion, or one
   * of them moved since the preview, refuses the whole plan before anything is written; so does,
   * when a group is a filter group, a roster resolved again that differs from `plan.roster` (a
   * filter's matches move with labels, not with the group's revision). That check runs before any
   * replay, so retrying a finished sync after a label changed is refused, not replayed. Then the
   * allocation changes (so a refused one leaves the roster as it was), new roster rows (planning,
   * no target or budget), restored rows and archived rows, each at the revision the preview
   * read. Gifts added after the preview are not checked here: the next preview asks about any
   * that name someone off the roster. The writes are not one atomic step: one refused (a record moved on) leaves the earlier
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
    const chosen: GiftRecord<"group">[] = []
    for (const [id, revision] of Object.entries(plan.groupRevisions)) {
      const g = await this.store.get("group", meta.ownerId, id)
      if (g?.revision !== revision) moved.push(`group ${id}`)
      if (g !== null) chosen.push(g)
    }
    if (moved.length === 0) {
      // A filter group's matches move with recipients' labels, not with the group's revision: the
      // roster is resolved again, and a different one is refused like a moved record.
      if (chosen.some((g) => g.filter !== undefined && g.filter !== null)) {
        const recipients = await this.store.list("recipient", meta.ownerId, {
          includeArchived: true,
        })
        const ordered = occasion.groupIds.flatMap((id) => chosen.filter((g) => g.id === id))
        const now = rosterIds(
          previewRoster(
            resolveGroups(ordered, recipients),
            occasion.includeIds,
            occasion.excludeIds,
          ),
        )
        if (JSON.stringify(now) !== JSON.stringify(plan.roster)) {
          moved.push("the recipients a filter group matches")
        }
      }
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

  /**
   * Writes the import rows the owner approved after review (`reviewGiftImport`, docket#102) and
   * answers each with its outcome (`applyGiftImportRows` has the rules). Not atomic: a row that
   * fails leaves the rows before it written and the rows after it tried. Keys come from content,
   * so `meta.idempotencyKey` is ignored and importing the same rows again creates nothing twice.
   * A default currency that is not an ISO 4217 code is refused before anything is written.
   */
  applyGiftImport(
    meta: GiftWriteMeta,
    rows: readonly GiftImportReviewed[],
    options: GiftImportApplyOptions,
  ): Promise<GiftImportOutcome[]> {
    return applyGiftImportRows(this, meta, rows, options)
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

/** The parts of a rollover preview that decide its writes, in one canonical string. */
function rolloverKey(p: GiftRolloverPreview): string {
  const by = <T>(xs: readonly T[], id: (x: T) => string) =>
    [...xs].sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0))
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v
  return JSON.stringify(
    canon({
      fromOccasionId: p.fromOccasionId,
      fromRevision: p.fromRevision,
      groupRevisions: p.groupRevisions,
      occasion: p.occasion,
      roster: by(p.roster, (r) => r.recipientId),
      ideas: by(p.ideas, (i) => i.fromAllocationId).map((i) => ({
        ...i,
        recipientIds: [...i.recipientIds].sort(),
        dropped: [...i.dropped].sort(),
      })),
    }),
  )
}
