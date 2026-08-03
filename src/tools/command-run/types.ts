export const COMMAND_TYPES = [
  "read",
  "glob",
  "grep",
  "apply_patch",
  "shell",
  "task_status",
  "web_discover",
  "read_media",
] as const

export type CommandType = (typeof COMMAND_TYPES)[number]
export type CommandInput = {
  command_type: CommandType
  command_line: string
  step: number
  timeout_ms?: number
}

export type ParsedCommand = Omit<CommandInput, "timeout_ms"> & {
  inputIndex: number
  timeout_ms?: number
}
export type CommandStatus = "completed" | "failed" | "denied" | "cancelled" | "timed_out"
export type CommandResult = {
  command_type: CommandType
  inputIndex: number
  step: number
  status: CommandStatus
  output: string
  metadata: Record<string, unknown>
  attachments?: CommandAttachment[]
}

export const COMMAND_PHASES = [
  "queued",
  "permission",
  "rewriting",
  "running",
  "completed",
  "failed",
  "denied",
  "cancelled",
  "timed_out",
] as const

export type CommandPhase = (typeof COMMAND_PHASES)[number]
export type CommandTerminalStatus = Extract<
  CommandPhase,
  "completed" | "failed" | "denied" | "cancelled" | "timed_out"
>
export type CommandTraceUpdate = {
  originalCommand?: string
  executedCommand?: string
  rewriteStatus?: string
  exitCode?: number
  stdoutChars?: number
  stderrChars?: number
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  resultPreview?: string
}
export type CommandTraceRecord = {
  version: 1
  inputIndex: number
  step: number
  commandType: CommandType
  commandLine: string
  phase: CommandPhase
  timestamps: Partial<Record<CommandPhase, number>>
  durationMs: number
  originalCommand?: string
  executedCommand?: string
  rewriteStatus?: string
  exitCode?: number
  stdoutChars: number
  stderrChars: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
  resultPreview?: string
  terminalStatus?: CommandTerminalStatus
}
export type CommandRunTrace = {
  version: 1
  records: CommandTraceRecord[]
  summary: {
    total: number
    completed: number
    failed: number
    denied: number
    cancelled: number
    timedOut: number
  }
}

export type AdapterResult = {
  output: string
  metadata?: Record<string, unknown>
  attachments?: CommandAttachment[]
}

export type CommandAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
  byteLength: number
}

export type ExecutionClass = "parallel-read" | "exclusive-read" | "mutation"

export const TASK_TYPES = [
  "implementation",
  "new_build",
  "debugging",
  "refactoring",
  "architecture",
  "review",
  "research",
  "data_research",
  "visual_inspection",
  "frontend",
  "website",
  "interactive_3d",
  "editorial",
  "operations",
] as const
export type TaskType = (typeof TASK_TYPES)[number]

export type TaskCheckpoint = {
  version: 1
  task_group: string
  task_type: readonly TaskType[]
  status: "doing" | "question" | "done"
  compact_context?: string
}
