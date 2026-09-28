import type { ReplyInput } from "./dispatch.js"
import type { ReplyKind } from "./model.js"
import type { MessageRef, OutgoingMessage, Store } from "./ports.js"

/**
 * Buttons that route back (plan section 5.5, reply channel). A Notifier renders a message's
 * actions as buttons; each button carries a reply reference -- which reply, to which occurrence
 * or task -- as a short string, and a press hands that string back. `replyForRef` turns it into
 * the `ReplyInput` the dispatcher takes, after checking the presser may answer that task.
 *
 * The encoding is `<kind>.<o|t>.<id>[.<choice>]`: `d.o.o17` is "done" on occurrence o17,
 * `a.t.t4` is "accept" on task t4's invitation, `c.o.o17.keep` is the decision "keep". It must
 * fit a Discord custom id (at most 100 characters), so ids are the Store's, as short as it makes
 * them; a Store id must not contain a dot, and an encoding over `MAX_REF_LENGTH` throws.
 */

/** Discord's limit on a component's custom id. */
export const MAX_REF_LENGTH = 100

/** The reply kinds a button can carry; `text` arrives as a message, never a press. */
export type ButtonReplyKind = Exclude<ReplyKind, "text">

const CODE: Record<ButtonReplyKind, string> = {
  accept: "a",
  decline: "x",
  opt_out: "q",
  done: "d",
  snooze: "s",
  decision: "c",
}
const KIND = Object.fromEntries(Object.entries(CODE).map(([k, c]) => [c, k])) as Record<
  string,
  ButtonReplyKind
>

export interface ReplyRef extends MessageRef {
  kind: ButtonReplyKind
  /** For a `decision`: the choice pressed. */
  choice?: string
}

export class ReplyRefError extends Error {
  override name = "ReplyRefError"
}

export function encodeReplyRef(ref: ReplyRef): string {
  const [scope, id] = ref.occurrenceId === null ? ["t", ref.taskId] : ["o", ref.occurrenceId]
  if (id.includes(".")) throw new ReplyRefError(`a Store id with a dot cannot be encoded: ${id}`)
  const base = `${CODE[ref.kind]}.${scope}.${id}`
  if (ref.kind === "decision" && !ref.choice) {
    throw new ReplyRefError("a decision needs its choice")
  }
  const encoded = ref.kind === "decision" ? `${base}.${ref.choice}` : base
  if (encoded.length > MAX_REF_LENGTH) {
    throw new ReplyRefError(`a reference over ${MAX_REF_LENGTH} characters: ${encoded}`)
  }
  return encoded
}

/** The parts of an encoded reference, or null when the string is not one. */
export function decodeReplyRef(
  encoded: string,
): { kind: ButtonReplyKind; scope: "o" | "t"; id: string; choice?: string } | null {
  const m = /^([a-z])\.([ot])\.([^.]+)(?:\.(.+))?$/.exec(encoded)
  const kind = m ? KIND[m[1] ?? ""] : undefined
  if (!m || !kind || m[3] === undefined) return null
  const scope = m[2] === "o" ? "o" : "t"
  if (kind === "decision") {
    return m[4] === undefined ? null : { kind, scope, id: m[3], choice: m[4] }
  }
  return m[4] === undefined ? { kind, scope, id: m[3] } : null
}

export type ReplyForRef = { ok: true; input: ReplyInput } | { ok: false; error: string }

/** The kinds that answer a run: the owner's alone (plan 1.1, "they do not act on the task"). */
const RUN_KINDS: ReadonlySet<ReplyKind> = new Set(["done", "snooze", "decision"])

/**
 * The reply a press stands for, when `userId` may give it: the owner answers a run, once, while
 * the task is active; an invited person accepts or declines; an accepted recipient opts out.
 * Recipients receive only (plan 1.1), so a run's buttons are the owner's. Anything else -- an
 * unknown reference, a task or run that is gone or over, a run already answered, someone else's
 * button -- is an error to show the presser, never a reply.
 */
export async function replyForRef(
  store: Store,
  encoded: string,
  userId: string,
): Promise<ReplyForRef> {
  const ref = decodeReplyRef(encoded)
  if (!ref) return { ok: false, error: "That button is not one of mine." }
  const run = RUN_KINDS.has(ref.kind)
  if (run && ref.scope !== "o") return { ok: false, error: "That button is not one of mine." }
  let taskId = ref.id
  let occurrenceId: string | null = null
  if (ref.scope === "o") {
    const occurrence = await store.getOccurrence(ref.id)
    if (!occurrence) return { ok: false, error: "That run no longer exists." }
    if (run && occurrence.status !== "done") return { ok: false, error: OVER }
    taskId = occurrence.taskId
    occurrenceId = occurrence.id
  }
  const task = await store.getTask(taskId)
  if (!task) return { ok: false, error: "That task no longer exists." }
  const mine = (await store.listRecipients(task.id)).find((r) => r.userId === userId)
  const allowed =
    ref.kind === "accept" || ref.kind === "decline"
      ? mine?.state === "invited"
      : ref.kind === "opt_out"
        ? mine?.state === "accepted"
        : task.ownerId === userId
  if (!allowed) return { ok: false, error: "That button is not yours to press any more." }
  if (run) {
    if (task.status !== "active") return { ok: false, error: OVER }
    const answered = (await store.listReplies(task.id)).some(
      (r) => r.occurrenceId === occurrenceId && RUN_KINDS.has(r.kind),
    )
    if (answered) return { ok: false, error: "That run has already been answered." }
  }
  return {
    ok: true,
    input: {
      taskId: task.id,
      occurrenceId,
      userId,
      kind: ref.kind,
      payload: ref.kind === "decision" ? { choice: ref.choice } : null,
    },
  }
}

const OVER = "That run is over; answer the latest message instead."

export interface ReplyButton {
  kind: ButtonReplyKind
  label: string
  /** The encoded reference the press hands back. */
  ref: string
}

const LABELS: Record<Exclude<ButtonReplyKind, "decision">, string> = {
  accept: "Accept",
  decline: "Decline",
  opt_out: "Stop sending me this",
  done: "Done",
  snooze: "Snooze 1h",
}

/**
 * The buttons a message offers, in order, each with its label and encoded reference. Empty when
 * the message has no `ref` (nothing to route a press to). A `decision` becomes one button per
 * choice. A repeated action or choice is offered once: Discord refuses two components with one
 * custom id.
 */
export function replyButtons(message: OutgoingMessage): ReplyButton[] {
  const ref = message.ref
  if (!ref) return []
  const buttons: ReplyButton[] = []
  const add = (button: ReplyButton) => {
    if (!buttons.some((b) => b.ref === button.ref)) buttons.push(button)
  }
  for (const kind of message.actions ?? []) {
    if (kind === "text") continue
    if (kind === "decision") {
      for (const choice of message.decisions ?? []) {
        add({ kind, label: choice, ref: encodeReplyRef({ ...ref, kind, choice }) })
      }
      continue
    }
    add({ kind, label: LABELS[kind], ref: encodeReplyRef({ ...ref, kind }) })
  }
  return buttons
}
