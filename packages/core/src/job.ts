/**
 * A model call as data (plan sections 5.4 and 5.12). An execute-lane type turns its config, state
 * and history into a JobSpec; the runner on roshne's host executes it blind through the Claude
 * Code CLI in print mode and returns a JobResult; the type turns that into findings,
 * notifications and new state. Nothing here calls a model, and there is no API-key path.
 * Rackbops/docket-runner's wire `Job` is this spec plus an id and a lease.
 */

export interface JobSpec {
  /** The whole prompt; the runner sends it on stdin, never argv. */
  prompt: string
  /** `--model`; the runner's default applies when absent. */
  model?: string
  /** `--json-schema`; when present the result must carry `structuredOutput`. */
  jsonSchema?: Record<string, unknown>
  /** `--allowedTools`; defaults to the read-and-web set. */
  allowedTools?: string[]
  /** `--disallowedTools`; defaults to the shell and file tools. */
  disallowedTools?: string[]
  /** `--max-turns`; the runner's default applies when absent. */
  maxTurns?: number
  /** `--max-budget-usd`; the runner's default applies when absent. */
  maxBudgetUsd?: number
  /** `--resume <session_id>`: continue a conversation (the intake dialogue, E10). */
  resumeSessionId?: string
  /** Per-Job wall-clock limit for the CLI call, in milliseconds. */
  timeoutMs?: number
}

export type FailureKind =
  | "auth_failed"
  | "usage_limit"
  | "turn_cap"
  | "budget_cap"
  | "schema_miss"
  | "timeout"
  | "error"

export interface JobSuccess {
  kind: "success"
  /** The CLI's `result` text. */
  result: string
  /** The CLI's `structured_output` when the Job carried a JSON schema. */
  structuredOutput?: unknown
  sessionId?: string
  /** The CLI's client-side list-price estimate; a proxy under a subscription, not a bill. */
  totalCostUsd?: number
  usage?: unknown
  numTurns?: number
  durationMs: number
}

export interface JobFailure {
  kind: FailureKind
  /** Operator-readable, secret-free. */
  detail: string
  /** For `usage_limit`: when the window resets, if the CLI's message said. */
  resetsAt?: string
  /** The CLI's `api_error_status` when it reported one. */
  apiErrorStatus?: number
  sessionId?: string
  totalCostUsd?: number
  durationMs: number
}

export type JobResult = JobSuccess | JobFailure

/** The read-and-web tool allowlist every execute-lane run gets (plan 5.6). */
export const DEFAULT_ALLOWED_TOOLS = ["WebSearch", "WebFetch"] as const
/** The shell and file tools no run may use. */
export const DEFAULT_DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task"] as const
