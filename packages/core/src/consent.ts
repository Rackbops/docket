import type { InviteBlock, Reply, Task, TaskRecipient } from "./model.js"
import type { Actor, Store } from "./ports.js"

/**
 * Invitations, consent and the decline rule (plan section 5.5). A recipient receives results
 * only after accepting; every later message carries an opt-out. roshne's rule (2026-09-26): a
 * decline blocks that owner's invitations to that person for 24 hours, and a second decline of the
 * same owner's invitations is a block until an admin lifts it. Opting out of an accepted task is
 * not a decline.
 */

export const DECLINE_BLOCK_MS = 24 * 60 * 60 * 1000

export class ConsentError extends Error {
  override name = "ConsentError"
}

export type InviteResult =
  | { ok: true; recipient: TaskRecipient }
  | { ok: false; reason: "not_owner" | "self" | "already_invited" | "blocked"; block?: InviteBlock }

/** The block in force between an owner and a recipient at `now`, if any. */
export async function activeBlock(
  store: Store,
  ownerId: string,
  recipientId: string,
  now: Date,
): Promise<InviteBlock | null> {
  const blocks = await store.listBlocks(ownerId, recipientId)
  return (
    blocks.find(
      (b) =>
        b.liftedAt === null && (b.expiresAt === null || Date.parse(b.expiresAt) > now.getTime()),
    ) ?? null
  )
}

/** The owner (or an admin) invites a person to receive a task's results. */
export async function invite(
  store: Store,
  actor: Actor,
  task: Task,
  recipientId: string,
  now: Date,
): Promise<InviteResult> {
  if (!actor.admin && actor.userId !== task.ownerId) return { ok: false, reason: "not_owner" }
  if (recipientId === task.ownerId) return { ok: false, reason: "self" }
  const existing = (await store.listRecipients(task.id)).find((r) => r.userId === recipientId)
  if (existing && (existing.state === "invited" || existing.state === "accepted")) {
    return { ok: false, reason: "already_invited" }
  }
  const block = await activeBlock(store, task.ownerId, recipientId, now)
  if (block) return { ok: false, reason: "blocked", block }
  const at = now.toISOString()
  const recipient = await store.setRecipient(task.id, recipientId, "invited", at)
  await store.addTaskEvent({
    taskId: task.id,
    actorId: actor.userId,
    kind: "recipient_invited",
    detail: recipientId,
    at,
  })
  return { ok: true, recipient }
}

export interface InviteResponse {
  recipient: TaskRecipient
  reply: Reply
  /** The block a decline created, if any. */
  block: InviteBlock | null
}

/** The invited person accepts or declines. A decline writes the block the rule calls for. */
export async function respondToInvite(
  store: Store,
  task: Task,
  recipientId: string,
  answer: "accept" | "decline",
  now: Date,
  occurrenceId: string | null = null,
): Promise<InviteResponse> {
  const existing = (await store.listRecipients(task.id)).find((r) => r.userId === recipientId)
  if (existing?.state !== "invited") {
    throw new ConsentError(`${recipientId} has no open invitation to task ${task.id}`)
  }
  const at = now.toISOString()
  const reply = await store.addReply({
    occurrenceId,
    taskId: task.id,
    userId: recipientId,
    kind: answer,
    payload: null,
    at,
  })
  if (answer === "accept") {
    const recipient = await store.setRecipient(task.id, recipientId, "accepted", at)
    await store.addTaskEvent({
      taskId: task.id,
      actorId: recipientId,
      kind: "recipient_accepted",
      detail: recipientId,
      at,
    })
    return { recipient, reply, block: null }
  }
  const recipient = await store.setRecipient(task.id, recipientId, "declined", at)
  await store.addTaskEvent({
    taskId: task.id,
    actorId: recipientId,
    kind: "recipient_declined",
    detail: recipientId,
    at,
  })
  const earlierDeclines = (await store.listBlocks(task.ownerId, recipientId)).filter(
    (b) => b.declineReplyId !== null,
  )
  const permanent = earlierDeclines.length > 0
  const block = await store.createBlock({
    ownerId: task.ownerId,
    recipientId,
    expiresAt: permanent ? null : new Date(now.getTime() + DECLINE_BLOCK_MS).toISOString(),
    declineReplyId: reply.id,
    at,
  })
  await store.addTaskEvent({
    taskId: task.id,
    actorId: recipientId,
    kind: "blocked",
    detail: permanent ? `${recipientId} permanent` : `${recipientId} 24h`,
    at,
  })
  return { recipient, reply, block }
}

/** An accepted recipient stops receiving. Not a decline: no block is written. */
export async function optOut(
  store: Store,
  task: Task,
  recipientId: string,
  now: Date,
  occurrenceId: string | null = null,
): Promise<Reply> {
  const at = now.toISOString()
  await store.setRecipient(task.id, recipientId, "opted_out", at)
  await store.addTaskEvent({
    taskId: task.id,
    actorId: recipientId,
    kind: "recipient_opted_out",
    detail: recipientId,
    at,
  })
  return store.addReply({
    occurrenceId,
    taskId: task.id,
    userId: recipientId,
    kind: "opt_out",
    payload: null,
    at,
  })
}

/** Only an admin lifts a block. */
export async function liftBlock(
  store: Store,
  actor: Actor,
  blockId: string,
  now: Date,
): Promise<InviteBlock> {
  if (!actor.admin) throw new ConsentError("only an admin lifts a block")
  const block = await store.getBlock(blockId)
  if (!block) throw new ConsentError(`no block ${blockId}`)
  return store.liftBlock(blockId, actor.userId, now.toISOString())
}
