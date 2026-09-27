import type { Lane } from "./lanes.js"
import type {
  ConsentState,
  InviteBlock,
  Occurrence,
  OccurrenceEvent,
  Reply,
  SeriesPoint,
  Task,
  TaskEvent,
  TaskRecipient,
  User,
} from "./model.js"
import type {
  NewBlock,
  NewEvent,
  NewOccurrence,
  NewReply,
  NewSeriesPoint,
  NewTask,
  NewTaskEvent,
  NewUser,
  OccurrenceFilter,
  OccurrencePatch,
  SeriesFilter,
  Store,
  TaskFilter,
  TaskPatch,
  UserPatch,
} from "./ports.js"

/**
 * The Store port in memory: the reference semantics every host adapter must keep, and the fake
 * the tests run on. Ids are `<prefix><n>` in creation order; every read returns a copy.
 */
export class MemoryStore implements Store {
  private readonly users = new Map<string, User>()
  private readonly tasks = new Map<string, Task>()
  private readonly recipients = new Map<string, TaskRecipient>()
  private readonly blocks = new Map<string, InviteBlock>()
  private readonly occurrences = new Map<string, Occurrence>()
  private readonly events: OccurrenceEvent[] = []
  private readonly taskEvents: TaskEvent[] = []
  private readonly replies: Reply[] = []
  private readonly series: SeriesPoint[] = []
  private seq = 0

  private id(prefix: string): string {
    this.seq += 1
    return `${prefix}${this.seq}`
  }

  private static copy<T>(value: T): T {
    return structuredClone(value)
  }

  async getUser(id: string): Promise<User | null> {
    return MemoryStore.copy(this.users.get(id) ?? null)
  }

  async findUserByDiscordId(discordId: string): Promise<User | null> {
    const hit = [...this.users.values()].find((u) => u.discordId === discordId)
    return MemoryStore.copy(hit ?? null)
  }

  async findUserBySubject(usrSubject: string): Promise<User | null> {
    const hit = [...this.users.values()].find((u) => u.usrSubject === usrSubject)
    return MemoryStore.copy(hit ?? null)
  }

  async createUser(input: NewUser): Promise<User> {
    const user: User = {
      id: this.id("u"),
      discordId: input.discordId ?? null,
      usrSubject: input.usrSubject ?? null,
      displayName: input.displayName ?? null,
      timeZone: input.timeZone ?? "UTC",
      preferredHour: input.preferredHour ?? 9,
      admin: input.admin ?? false,
      createdAt: input.at,
    }
    this.users.set(user.id, user)
    return MemoryStore.copy(user)
  }

  async updateUser(id: string, patch: UserPatch): Promise<User> {
    const cur = this.users.get(id)
    if (!cur) throw new Error(`no user ${id}`)
    const next: User = { ...cur }
    if (patch.discordId !== undefined) next.discordId = patch.discordId
    if (patch.usrSubject !== undefined) next.usrSubject = patch.usrSubject
    if (patch.displayName !== undefined) next.displayName = patch.displayName
    if (patch.timeZone !== undefined) next.timeZone = patch.timeZone
    if (patch.preferredHour !== undefined) next.preferredHour = patch.preferredHour
    if (patch.admin !== undefined) next.admin = patch.admin
    this.users.set(id, next)
    return MemoryStore.copy(next)
  }

  async createTask(input: NewTask): Promise<Task> {
    const task: Task = {
      id: this.id("t"),
      ownerId: input.ownerId,
      type: input.type,
      title: input.title,
      config: MemoryStore.copy(input.config),
      state: MemoryStore.copy(input.state ?? null),
      schedule: MemoryStore.copy(input.schedule),
      lane: input.lane,
      capabilities: [...input.capabilities],
      status: "active",
      createdAt: input.at,
      updatedAt: input.at,
    }
    this.tasks.set(task.id, task)
    return MemoryStore.copy(task)
  }

  async getTask(id: string): Promise<Task | null> {
    return MemoryStore.copy(this.tasks.get(id) ?? null)
  }

  async listTasks(filter: TaskFilter = {}): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((t) => filter.ownerId === undefined || t.ownerId === filter.ownerId)
      .filter((t) => filter.status === undefined || t.status === filter.status)
      .filter((t) => filter.type === undefined || t.type === filter.type)
      .map((t) => MemoryStore.copy(t))
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task> {
    const cur = this.tasks.get(id)
    if (!cur) throw new Error(`no task ${id}`)
    const next: Task = { ...cur, updatedAt: patch.at }
    if (patch.title !== undefined) next.title = patch.title
    if (patch.config !== undefined) next.config = MemoryStore.copy(patch.config)
    if (patch.state !== undefined) next.state = MemoryStore.copy(patch.state)
    if (patch.schedule !== undefined) next.schedule = MemoryStore.copy(patch.schedule)
    if (patch.capabilities !== undefined) next.capabilities = [...patch.capabilities]
    if (patch.status !== undefined) next.status = patch.status
    this.tasks.set(id, next)
    return MemoryStore.copy(next)
  }

  async listRecipients(taskId: string): Promise<TaskRecipient[]> {
    return [...this.recipients.values()]
      .filter((r) => r.taskId === taskId)
      .map((r) => MemoryStore.copy(r))
  }

  async setRecipient(
    taskId: string,
    userId: string,
    state: ConsentState,
    at: string,
  ): Promise<TaskRecipient> {
    const recipient: TaskRecipient = { taskId, userId, state, at }
    this.recipients.set(`${taskId}:${userId}`, recipient)
    return MemoryStore.copy(recipient)
  }

  async removeRecipient(taskId: string, userId: string): Promise<void> {
    this.recipients.delete(`${taskId}:${userId}`)
  }

  async listBlocks(ownerId: string, recipientId: string): Promise<InviteBlock[]> {
    return [...this.blocks.values()]
      .filter((b) => b.ownerId === ownerId && b.recipientId === recipientId)
      .map((b) => MemoryStore.copy(b))
  }

  async getBlock(id: string): Promise<InviteBlock | null> {
    return MemoryStore.copy(this.blocks.get(id) ?? null)
  }

  async createBlock(input: NewBlock): Promise<InviteBlock> {
    const block: InviteBlock = {
      id: this.id("b"),
      ownerId: input.ownerId,
      recipientId: input.recipientId,
      expiresAt: input.expiresAt,
      declineReplyId: input.declineReplyId,
      liftedBy: null,
      liftedAt: null,
      createdAt: input.at,
    }
    this.blocks.set(block.id, block)
    return MemoryStore.copy(block)
  }

  async liftBlock(id: string, adminId: string, at: string): Promise<InviteBlock> {
    const cur = this.blocks.get(id)
    if (!cur) throw new Error(`no block ${id}`)
    const next: InviteBlock = { ...cur, liftedBy: adminId, liftedAt: at }
    this.blocks.set(id, next)
    return MemoryStore.copy(next)
  }

  async createOccurrence(input: NewOccurrence): Promise<Occurrence | null> {
    if ([...this.occurrences.values()].some((o) => o.dedupeKey === input.dedupeKey)) return null
    const occurrence: Occurrence = {
      id: this.id("o"),
      taskId: input.taskId,
      lane: input.lane,
      dueAt: input.dueAt,
      startedAt: null,
      finishedAt: null,
      status: "queued",
      late: false,
      dedupeKey: input.dedupeKey,
      summary: null,
      costUsd: null,
      error: null,
      createdAt: input.at,
    }
    this.occurrences.set(occurrence.id, occurrence)
    return MemoryStore.copy(occurrence)
  }

  async getOccurrence(id: string): Promise<Occurrence | null> {
    return MemoryStore.copy(this.occurrences.get(id) ?? null)
  }

  async listOccurrences(filter: OccurrenceFilter = {}): Promise<Occurrence[]> {
    return [...this.occurrences.values()]
      .filter((o) => filter.taskId === undefined || o.taskId === filter.taskId)
      .filter((o) => filter.lane === undefined || o.lane === filter.lane)
      .filter((o) => filter.status === undefined || o.status === filter.status)
      .filter((o) => filter.dueBefore === undefined || o.dueAt <= filter.dueBefore)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.createdAt.localeCompare(b.createdAt))
      .map((o) => MemoryStore.copy(o))
  }

  async updateOccurrence(id: string, patch: OccurrencePatch): Promise<Occurrence> {
    const cur = this.occurrences.get(id)
    if (!cur) throw new Error(`no occurrence ${id}`)
    const next: Occurrence = { ...cur }
    if (patch.status !== undefined) next.status = patch.status
    if (patch.startedAt !== undefined) next.startedAt = patch.startedAt
    if (patch.finishedAt !== undefined) next.finishedAt = patch.finishedAt
    if (patch.late !== undefined) next.late = patch.late
    if (patch.summary !== undefined) next.summary = patch.summary
    if (patch.costUsd !== undefined) next.costUsd = patch.costUsd
    if (patch.error !== undefined) next.error = patch.error
    this.occurrences.set(id, next)
    return MemoryStore.copy(next)
  }

  async deleteQueuedOccurrences(taskId: string): Promise<number> {
    let removed = 0
    for (const [id, o] of this.occurrences) {
      if (o.taskId === taskId && o.status === "queued") {
        this.occurrences.delete(id)
        removed += 1
      }
    }
    return removed
  }

  async requeueRunning(lane?: Lane): Promise<string[]> {
    const ids: string[] = []
    for (const [id, o] of this.occurrences) {
      if (o.status === "running" && (lane === undefined || o.lane === lane)) {
        this.occurrences.set(id, { ...o, status: "queued" })
        ids.push(id)
      }
    }
    return ids
  }

  async addEvent(input: NewEvent): Promise<OccurrenceEvent> {
    const event: OccurrenceEvent = { id: this.id("e"), ...input }
    this.events.push(event)
    return MemoryStore.copy(event)
  }

  async listEvents(occurrenceId: string, after?: string): Promise<OccurrenceEvent[]> {
    const start = after === undefined ? 0 : this.events.findIndex((e) => e.id === after) + 1
    return this.events
      .slice(start)
      .filter((e) => e.occurrenceId === occurrenceId)
      .map((e) => MemoryStore.copy(e))
  }

  async addTaskEvent(input: NewTaskEvent): Promise<TaskEvent> {
    const event: TaskEvent = { id: this.id("h"), ...input }
    this.taskEvents.push(event)
    return MemoryStore.copy(event)
  }

  async listTaskEvents(taskId: string): Promise<TaskEvent[]> {
    return this.taskEvents.filter((e) => e.taskId === taskId).map((e) => MemoryStore.copy(e))
  }

  async addReply(input: NewReply): Promise<Reply> {
    const reply: Reply = { id: this.id("r"), ...input, payload: MemoryStore.copy(input.payload) }
    this.replies.push(reply)
    return MemoryStore.copy(reply)
  }

  async listReplies(taskId: string): Promise<Reply[]> {
    return this.replies.filter((r) => r.taskId === taskId).map((r) => MemoryStore.copy(r))
  }

  async addSeriesPoint(input: NewSeriesPoint): Promise<SeriesPoint> {
    const point: SeriesPoint = {
      id: this.id("s"),
      taskId: input.taskId,
      at: input.at,
      value: input.value,
      unit: input.unit ?? null,
      note: input.note ?? null,
    }
    this.series.push(point)
    return MemoryStore.copy(point)
  }

  async listSeries(taskId: string, filter: SeriesFilter = {}): Promise<SeriesPoint[]> {
    const points = this.series
      .filter((p) => p.taskId === taskId)
      .filter((p) => filter.since === undefined || p.at >= filter.since)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    const kept = filter.limit === undefined ? points : points.slice(-filter.limit)
    return kept.map((p) => MemoryStore.copy(p))
  }
}
