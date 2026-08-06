import { createTraceRecorder } from "./trace.js"
import type {
  AdapterResult,
  CommandPhase,
  CommandResult,
  CommandRunTrace,
  CommandTraceUpdate,
  ParsedCommand,
  ExecutionClass,
} from "./types.js"

type ScheduleDependencies = {
  signal: AbortSignal
  ask(command: ParsedCommand): Promise<void>
  execute(
    command: ParsedCommand,
    signal: AbortSignal,
    updatePhase: (phase: CommandPhase, update?: CommandTraceUpdate) => void
  ): Promise<AdapterResult>
  executionClass?(command: ParsedCommand): ExecutionClass
  onTrace?(trace: CommandRunTrace): void
  now?(): number
  maxOutputChars: number
  maxAttachments?: number
  maxAttachmentBytes?: number
}

export async function runCommandSchedule(
  commands: readonly ParsedCommand[],
  dependencies: ScheduleDependencies
): Promise<CommandResult[]> {
  const ordered = [...commands].sort((left, right) => left.step - right.step || left.inputIndex - right.inputIndex)
  const trace = createTraceRecorder(ordered, dependencies.onTrace ?? (() => {}), dependencies.now)
  const results = new Map<number, CommandResult>()
  const attachmentBudget = { count: 0, bytes: 0 }
  const steps = [...new Set(ordered.map((command) => command.step))]
  let stopAfterStep = false

  for (const step of steps) {
    const current = ordered.filter((command) => command.step === step)
    if (stopAfterStep || dependencies.signal.aborted) {
      for (const command of current) setCancelled(command, results, trace, "Cancelled because an earlier step did not complete.")
      continue
    }

    for (let index = 0; index < current.length;) {
      const command = current[index]!
      if (classFor(command, dependencies) !== "parallel-read") {
        const result = await runOne(command, dependencies, attachmentBudget, trace)
        results.set(command.inputIndex, result)
        stopAfterStep ||= result.status !== "completed"
        index += 1
        if (result.status !== "completed") {
          for (const later of current.slice(index)) {
            setCancelled(later, results, trace, "Cancelled because an earlier command did not complete.")
          }
          index = current.length
        }
        continue
      }

      const readBatch: ParsedCommand[] = []
      while (index < current.length && classFor(current[index]!, dependencies) === "parallel-read") {
        readBatch.push(current[index]!)
        index += 1
      }
      const batchResults = await Promise.all(
        readBatch.map((item) => runOne(item, dependencies, attachmentBudget, trace))
      )
      batchResults.forEach((result) => results.set(result.inputIndex, result))
      const batchFailed = batchResults.some((result) => result.status !== "completed")
      stopAfterStep ||= batchFailed
      if (batchFailed) {
        for (const later of current.slice(index)) {
          setCancelled(later, results, trace, "Cancelled because an earlier command did not complete.")
        }
        break
      }
    }
  }

  return ordered.map((command) => results.get(command.inputIndex) ?? cancelledResult(command))
}

async function runOne(
  command: ParsedCommand,
  dependencies: ScheduleDependencies,
  attachmentBudget: { count: number; bytes: number },
  trace: ReturnType<typeof createTraceRecorder>
): Promise<CommandResult> {
  if (dependencies.signal.aborted) {
    trace.transition(command.inputIndex, "cancelled", { resultPreview: "Session cancelled." })
    return cancelledResult(command)
  }

  const executionTimeout = new AbortController()
  const combinedSignal = AbortSignal.any([dependencies.signal, executionTimeout.signal])
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let running = false
  const updatePhase = (phase: CommandPhase, update?: CommandTraceUpdate): void => {
    if (phase === "running" && !running) {
      running = true
      timeoutHandle = setTimeout(
        () => executionTimeout.abort(new DOMException("Command execution timed out", "TimeoutError")),
        command.timeout_ms
      )
    }
    trace.transition(command.inputIndex, phase, update)
  }

  try {
    updatePhase("permission")
    await dependencies.ask(command)
    if (dependencies.signal.aborted) return terminalResult(command, "cancelled", "Session cancelled.", trace)
    const result = await dependencies.execute(command, combinedSignal, updatePhase)
    if (executionTimeout.signal.aborted) return terminalResult(command, "timed_out", "Command execution timed out.", trace)
    if (dependencies.signal.aborted) return terminalResult(command, "cancelled", "Session cancelled.", trace)
    reserveAttachments(result, attachmentBudget, dependencies)
    const output = boundOutput(result.output, dependencies.maxOutputChars)
    const diagnostics = successDiagnostics(result, output, dependencies.maxOutputChars)
    trace.transition(command.inputIndex, "completed", diagnostics)
    return makeResult(command, "completed", output, result.metadata, result.attachments)
  } catch (error) {
    if (executionTimeout.signal.aborted && !dependencies.signal.aborted) {
      return terminalResult(command, "timed_out", "Command execution timed out.", trace, errorMetadata(error))
    }
    if (dependencies.signal.aborted || isAbort(error)) {
      return terminalResult(command, "cancelled", "Session cancelled.", trace, errorMetadata(error))
    }
    const status = isDenied(error) ? "denied" : "failed"
    const message = boundOutput(errorMessage(error), dependencies.maxOutputChars)
    const metadata = errorMetadata(error)
    trace.transition(command.inputIndex, status, failureDiagnostics(message, metadata))
    return makeResult(command, status, message, metadata)
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

function terminalResult(
  command: ParsedCommand,
  status: "cancelled" | "timed_out",
  message: string,
  trace: ReturnType<typeof createTraceRecorder>,
  metadata: Record<string, unknown> = {}
): CommandResult {
  trace.transition(command.inputIndex, status, failureDiagnostics(message, metadata))
  return makeResult(command, status, message, metadata)
}

function setCancelled(
  command: ParsedCommand,
  results: Map<number, CommandResult>,
  trace: ReturnType<typeof createTraceRecorder>,
  message: string
): void {
  trace.transition(command.inputIndex, "cancelled", { resultPreview: message })
  results.set(command.inputIndex, cancelledResult(command, message))
}

function successDiagnostics(
  result: AdapterResult,
  output: string,
  maximum: number
): CommandTraceUpdate {
  const metadata = result.metadata ?? {}
  return {
    ...recognizedDiagnostics(metadata),
    stdoutChars: numberMetadata(metadata.stdoutChars) ?? result.output.length,
    stderrChars: numberMetadata(metadata.stderrChars) ?? 0,
    stdoutTruncated: booleanMetadata(metadata.stdoutTruncated) === true || result.output.length > maximum,
    stderrTruncated: booleanMetadata(metadata.stderrTruncated) ?? false,
    resultPreview: output,
  }
}

function failureDiagnostics(message: string, metadata: Record<string, unknown>): CommandTraceUpdate {
  return {
    ...recognizedDiagnostics(metadata),
    stdoutChars: numberMetadata(metadata.stdoutChars) ?? 0,
    stderrChars: numberMetadata(metadata.stderrChars) ?? message.length,
    stdoutTruncated: booleanMetadata(metadata.stdoutTruncated) ?? false,
    stderrTruncated: booleanMetadata(metadata.stderrTruncated) ?? false,
    resultPreview: message,
  }
}

function recognizedDiagnostics(metadata: Record<string, unknown>): CommandTraceUpdate {
  const exitCode = numberMetadata(metadata.exitCode)
  return {
    ...(typeof metadata.originalCommand === "string" ? { originalCommand: metadata.originalCommand } : {}),
    ...(typeof metadata.executedCommand === "string" ? { executedCommand: metadata.executedCommand } : {}),
    ...(typeof metadata.rewriteStatus === "string" ? { rewriteStatus: metadata.rewriteStatus } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
  }
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanMetadata(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function reserveAttachments(
  result: AdapterResult,
  budget: { count: number; bytes: number },
  dependencies: ScheduleDependencies
): void {
  const attachments = result.attachments ?? []
  const nextCount = budget.count + attachments.length
  const nextBytes = budget.bytes + attachments.reduce((sum, attachment) => sum + attachment.byteLength, 0)
  if (dependencies.maxAttachments !== undefined && nextCount > dependencies.maxAttachments) {
    throw new Error(`command_run attachments exceed ${dependencies.maxAttachments} files`)
  }
  if (dependencies.maxAttachmentBytes !== undefined && nextBytes > dependencies.maxAttachmentBytes) {
    throw new Error(`command_run attachments exceed ${dependencies.maxAttachmentBytes} bytes`)
  }
  budget.count = nextCount
  budget.bytes = nextBytes
}

function makeResult(
  command: ParsedCommand,
  status: CommandResult["status"],
  output: string,
  metadata: Record<string, unknown> = {},
  attachments?: AdapterResult["attachments"]
): CommandResult {
  return {
    command_type: command.command_type,
    inputIndex: command.inputIndex,
    step: command.step,
    status,
    output,
    metadata,
    ...(attachments?.length ? { attachments } : {}),
  }
}

function classFor(command: ParsedCommand, dependencies: ScheduleDependencies): ExecutionClass {
  return dependencies.executionClass?.(command)
    ?? (command.command_type === "read" || command.command_type === "glob" || command.command_type === "grep" || command.command_type === "task_status" ? "parallel-read" : "mutation")
}

function cancelledResult(command: ParsedCommand, message = "Cancelled because an earlier step did not complete."): CommandResult {
  return makeResult(command, "cancelled", message)
}

function boundOutput(output: string, maximum: number): string {
  if (output.length <= maximum) return output
  const marker = "\n… output truncated"
  return `${output.slice(0, Math.max(0, maximum - marker.length))}${marker}`.slice(0, maximum)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorMetadata(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error) || !("metadata" in error)) return {}
  const metadata = error.metadata
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
}

function isDenied(error: unknown): boolean {
  const text = `${error instanceof Error ? error.name : ""} ${errorMessage(error)}`.toLowerCase()
  return text.includes("permission") && (text.includes("denied") || text.includes("reject"))
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
}
