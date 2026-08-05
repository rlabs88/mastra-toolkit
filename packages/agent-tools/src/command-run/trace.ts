import type {
  CommandPhase,
  CommandRunTrace,
  CommandTerminalStatus,
  CommandTraceRecord,
  CommandTraceUpdate,
  ParsedCommand,
} from "./types.js"

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
