import { lstat, realpath } from "node:fs/promises"

import { dirname, isAbsolute, relative, resolve, sep } from "node:path"



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

const COMMAND_KEYS = new Set(["command_type", "command_line", "step", "timeout_ms"])
const DEFAULT_TIMEOUT_MS = 120_000

export function parseCommands(value: unknown): ParsedCommand[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error("commands must contain between 1 and 20 items")
  }

  return value.map((item, inputIndex) => parseCommand(item, inputIndex))
}

function parseCommand(value: unknown, inputIndex: number): ParsedCommand {
  if (!isRecord(value)) throw new Error(`commands[${inputIndex}] must be an object`)
  const unknownKey = Object.keys(value).find((key) => !COMMAND_KEYS.has(key))
  if (unknownKey) throw new Error(`commands[${inputIndex}] has unknown field: ${unknownKey}`)
  if (!COMMAND_TYPES.includes(value.command_type as CommandInput["command_type"])) {
    throw new Error(`commands[${inputIndex}] has unsupported command_type`)
  }
  if (typeof value.command_line !== "string" || value.command_line.trim() === "") {
    throw new Error(`commands[${inputIndex}].command_line must be non-empty`)
  }
  if (!Number.isInteger(value.step) || (value.step as number) < 1) {
    throw new Error(`commands[${inputIndex}].step must be a positive integer`)
  }
  if (value.timeout_ms !== undefined && (
    !Number.isInteger(value.timeout_ms)
    || (value.timeout_ms as number) < 100
    || (value.timeout_ms as number) > 300_000
  )) {
    throw new Error("timeout_ms must be an integer between 100 and 300000")
  }
  return {
    ...(value as CommandInput),
    inputIndex,
    timeout_ms: (value.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS,
  }
}

export function parseStrictObject(
  command: ParsedCommand,
  allowedKeys: readonly string[]
): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(command.command_line)
  } catch {
    throw new Error(`${command.command_type} command_line must be a JSON object with only: ${allowedKeys.join(", ")}`)
  }
  if (!isRecord(value)) {
    throw new Error(`${command.command_type} command_line must be a JSON object with only: ${allowedKeys.join(", ")}`)
  }
  const allowed = new Set(allowedKeys)
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key))
  if (unknownKey) throw new Error(`${command.command_type} has unknown field: ${unknownKey}`)
  return value
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function resolveWorkspacePath(root: string, requestedPath: string): Promise<string> {
  if (requestedPath.includes("\0")) throw new Error("paths cannot contain null bytes")
  const canonicalRoot = await realpath(root)
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(canonicalRoot, requestedPath)
  assertWithinRoot(canonicalRoot, candidate)

  const existingAncestor = await findExistingAncestor(candidate, canonicalRoot)
  const canonicalAncestor = await realpath(existingAncestor)
  assertWithinRoot(canonicalRoot, canonicalAncestor)
  return candidate
}

function assertWithinRoot(root: string, candidate: string): void {
  const child = relative(root, candidate)
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))) return
  throw new Error(`path escapes workspace: ${candidate}`)
}

async function findExistingAncestor(candidate: string, root: string): Promise<string> {
  let current = candidate
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (current === root) return root
    const parent = dirname(current)
    if (parent === current) throw new Error(`cannot resolve path ancestor: ${candidate}`)
    current = parent
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

const MAX_COMMAND_JSON_CHARS = 100
const MAX_PREVIEW_CHARS = 120
const TERMINAL_PHASES = new Set<CommandPhase>([
  "completed",
  "failed",
  "denied",
  "cancelled",
  "timed_out",
])

export type TraceRecorder = {
  transition(inputIndex: number, phase: CommandPhase, update?: CommandTraceUpdate): void
  snapshot(): CommandRunTrace
}

export function createTraceRecorder(
  commands: readonly ParsedCommand[],
  publish: (trace: CommandRunTrace) => void,
  now: () => number = Date.now
): TraceRecorder {
  const records = new Map<number, CommandTraceRecord>()
  const queuedAt = now()
  for (const command of commands) {
    records.set(command.inputIndex, {
      version: 1,
      inputIndex: command.inputIndex,
      step: command.step,
      commandType: command.command_type,
      commandLine: boundJsonString(command.command_line, MAX_COMMAND_JSON_CHARS),
      phase: "queued",
      timestamps: { queued: queuedAt },
      durationMs: 0,
      stdoutChars: 0,
      stderrChars: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    })
  }

  const recorder: TraceRecorder = {
    transition(inputIndex, phase, update = {}) {
      const current = records.get(inputIndex)
      if (!current) return
      const timestamp = now()
      const terminalStatus = TERMINAL_PHASES.has(phase) ? phase as CommandTerminalStatus : undefined
      records.set(inputIndex, {
        ...current,
        ...boundedUpdate(update),
        phase,
        timestamps: { ...current.timestamps, [phase]: timestamp },
        durationMs: Math.max(0, timestamp - (current.timestamps.queued ?? timestamp)),
        ...(terminalStatus ? { terminalStatus } : {}),
      })
      publish(recorder.snapshot())
    },
    snapshot() {
      const ordered = [...records.values()]
        .sort((left, right) => left.step - right.step || left.inputIndex - right.inputIndex)
        .map((record) => structuredClone(record))
      return { version: 1, records: ordered, summary: summarize(ordered) }
    },
  }
  publish(recorder.snapshot())
  return recorder
}

function boundedUpdate(update: CommandTraceUpdate): CommandTraceUpdate {
  return {
    ...(update.originalCommand === undefined
      ? {}
      : { originalCommand: boundJsonString(update.originalCommand, MAX_COMMAND_JSON_CHARS) }),
    ...(update.executedCommand === undefined
      ? {}
      : { executedCommand: boundJsonString(update.executedCommand, MAX_COMMAND_JSON_CHARS) }),
    ...(update.rewriteStatus === undefined
      ? {}
      : { rewriteStatus: boundText(update.rewriteStatus, 80) }),
    ...(update.exitCode === undefined ? {} : { exitCode: update.exitCode }),
    ...(update.stdoutChars === undefined ? {} : { stdoutChars: nonNegative(update.stdoutChars) }),
    ...(update.stderrChars === undefined ? {} : { stderrChars: nonNegative(update.stderrChars) }),
    ...(update.stdoutTruncated === undefined ? {} : { stdoutTruncated: update.stdoutTruncated }),
    ...(update.stderrTruncated === undefined ? {} : { stderrTruncated: update.stderrTruncated }),
    ...(update.resultPreview === undefined
      ? {}
      : { resultPreview: boundText(update.resultPreview, MAX_PREVIEW_CHARS) }),
  }
}

function summarize(records: readonly CommandTraceRecord[]): CommandRunTrace["summary"] {
  const count = (status: CommandTerminalStatus) => records.filter((record) => record.terminalStatus === status).length
  return {
    total: records.length,
    completed: count("completed"),
    failed: count("failed"),
    denied: count("denied"),
    cancelled: count("cancelled"),
    timedOut: count("timed_out"),
  }
}

function nonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function boundText(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const marker = "… truncated"
  return `${value.slice(0, Math.max(0, maximum - marker.length))}${marker}`
}

function boundJsonString(value: string, maximum: number): string {
  if (JSON.stringify(value).length <= maximum) return value
  const marker = "… truncated"
  let lower = 0
  let upper = value.length
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2)
    if (JSON.stringify(`${value.slice(0, candidate)}${marker}`).length <= maximum) lower = candidate
    else upper = candidate - 1
  }
  return `${value.slice(0, lower)}${marker}`
}
