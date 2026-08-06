import { spawn } from "node:child_process";
import { lookup as systemLookup } from "node:dns/promises"
import { glob, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { isIP } from "node:net"
import { basename, dirname, relative } from "node:path"
import {
  createTraceRecorder,
  parseStrictObject,
  requireString,
  resolveWorkspacePath,
  TASK_TYPES,
  type AdapterResult,
  type CommandPhase,
  type CommandResult,
  type CommandRunTrace,
  type CommandTraceUpdate,
  type ExecutionClass,
  type ParsedCommand,
  type TaskCheckpoint,
  type TaskType,
} from "./command-run-contract.js"



const MAX_READ_CHARS = 40_000;
const MAX_MATCHES = 200;

export async function permissionPatterns(command: ParsedCommand, root: string, web: WebDependencies = {}): Promise<string[]> {
  if (command.command_type === "shell") return [command.command_line];
  if (command.command_type === "apply_patch") return Promise.all(patchPaths(command.command_line).map(path => resolveWorkspacePath(root, path)));
  if (command.command_type === "task_status") return ["task_status"];
  if (command.command_type === "web_discover") return validateWebPermission(command, root, web);
  if (command.command_type === "read_media") return [await resolveWorkspacePath(root, parseMediaRequest(command).path)];
  const parsed = parseObject(command);
  return [await resolveWorkspacePath(root, typeof parsed.path === "string" ? parsed.path : ".")];
}

export async function executeAdapter(
  command: ParsedCommand,
  root: string,
  signal: AbortSignal,
  web: WebDependencies = {},
  updatePhase: (phase: CommandPhase, update?: CommandTraceUpdate) => void = () => undefined,
): Promise<AdapterResult> {
  updatePhase("running");
  switch (command.command_type) {
    case "read": return executeRead(command, root);
    case "glob": return executeGlob(command, root);
    case "grep": return executeGrep(command, root, signal);
    case "apply_patch": return executePatch(command, root, signal);
    case "shell": return executeShell(command, root, signal);
    case "task_status": return executeTaskStatus(command);
    case "web_discover": return executeWebDiscover(command, root, signal, web);
    case "read_media": return executeReadMedia(command, root);
  }
}

export function executionClass(command: ParsedCommand): ExecutionClass {
  if (command.command_type === "web_discover") return parseWebRequest(command).mode === "extract" ? "parallel-read" : "mutation";
  if (command.command_type === "read_media") return "exclusive-read";
  if (["read", "glob", "grep", "task_status"].includes(command.command_type)) return "parallel-read";
  return "mutation";
}

export function commandRequiresApproval(command: ParsedCommand): boolean {
  return executionClass(command) === "mutation";
}

async function executeRead(command: ParsedCommand, root: string): Promise<AdapterResult> {
  const parsed = parseObject(command);
  const path = await resolveWorkspacePath(root, requireString(parsed.path, "path"));
  if (!(await stat(path)).isFile()) throw new Error("read path must be a file");
  const offset = integer(parsed.offset, "offset", 0, 1_000_000) ?? 0;
  const limit = integer(parsed.limit, "limit", 1, 2_000) ?? 500;
  const output = (await readFile(path, "utf8")).split("\n").slice(offset, offset + limit).join("\n");
  return { output: output.slice(0, MAX_READ_CHARS), metadata: { path: relative(root, path), offset, truncated: output.length > MAX_READ_CHARS } };
}

async function executeGlob(command: ParsedCommand, root: string): Promise<AdapterResult> {
  const parsed = parseObject(command);
  const pattern = requireString(parsed.pattern, "pattern");
  const base = await resolveWorkspacePath(root, typeof parsed.path === "string" ? parsed.path : ".");
  if (!(await stat(base)).isDirectory()) throw new Error("glob path must be a directory");
  const matches: string[] = [];
  for await (const match of glob(pattern, { cwd: base, withFileTypes: false, exclude: ["node_modules/**", ".git/**"] })) {
    const path = await resolveWorkspacePath(root, relative(root, base) + "/" + match);
    matches.push(relative(root, path));
    if (matches.length === MAX_MATCHES) break;
  }
  matches.sort();
  return { output: matches.join("\n") || "No matches.", metadata: { matches: matches.length, truncated: matches.length === MAX_MATCHES } };
}

async function executeGrep(command: ParsedCommand, root: string, signal: AbortSignal): Promise<AdapterResult> {
  const parsed = parseObject(command);
  const path = await resolveWorkspacePath(root, typeof parsed.path === "string" ? parsed.path : ".");
  const args = ["--line-number", "--no-heading", "--color", "never"];
  if (parsed.include !== undefined) args.push("--glob", requireString(parsed.include, "include"));
  args.push("--", requireString(parsed.pattern, "pattern"), path);
  const result = await runProcess("rg", args, { cwd: root, signal });
  if (![0, 1].includes(result.exitCode)) throw new Error(result.stderr || `rg exited ${result.exitCode}`);
  return { output: result.stdout || "No matches.", metadata: { ...result, matched: result.exitCode === 0 } };
}

async function executePatch(command: ParsedCommand, root: string, signal: AbortSignal): Promise<AdapterResult> {
  const paths = patchPaths(command.command_line);
  if (paths.length === 0) throw new Error("apply_patch requires unified diff file headers");
  await Promise.all(paths.map(path => resolveWorkspacePath(root, path)));
  const check = await runProcess("git", ["apply", "--check", "--whitespace=nowarn", "-"], { cwd: root, signal, stdin: command.command_line });
  if (check.exitCode !== 0) throw new Error(check.stderr || "patch validation failed");
  const applied = await runProcess("git", ["apply", "--whitespace=nowarn", "-"], { cwd: root, signal, stdin: command.command_line });
  if (applied.exitCode !== 0) throw new Error(applied.stderr || "patch application failed");
  return { output: `Applied patch to ${paths.length} path(s).`, metadata: { paths } };
}

async function executeShell(command: ParsedCommand, root: string, signal: AbortSignal): Promise<AdapterResult> {
  if (/(^|[^&])&($|[^&])|\b(?:nohup|disown)\b/.test(command.command_line)) throw new Error("background shell execution is not supported");
  const result = await runProcess(process.env.SHELL || "/bin/sh", ["-lc", command.command_line], { cwd: root, signal });
  if (result.exitCode !== 0) throw new ProcessFailure(result.stderr || result.stdout || `shell exited ${result.exitCode}`, { ...result });
  return { output: result.stdout || result.stderr || "Command completed.", metadata: { originalCommand: command.command_line, executedCommand: command.command_line, rewriteStatus: "native", ...result } };
}

function executeTaskStatus(command: ParsedCommand): AdapterResult {
  const parsed = parseObject(command);
  if (parsed.status !== "doing" && parsed.status !== "question" && parsed.status !== "done") throw new Error("status must be doing, question, or done");
  if (!Array.isArray(parsed.task_type) || parsed.task_type.length === 0 || parsed.task_type.some(item => !TASK_TYPES.includes(item as TaskType))) {
    throw new Error("task_type must contain unique supported values");
  }
  const checkpoint: TaskCheckpoint = {
    version: 1,
    task_group: boundedString(parsed.task_group, "task_group", 200),
    task_type: [...new Set(parsed.task_type)] as TaskType[],
    status: parsed.status,
    ...(typeof parsed.compact_context === "string" ? { compact_context: boundedString(parsed.compact_context, "compact_context", 4_000) } : {}),
  };
  if (checkpoint.task_type.length !== parsed.task_type.length) throw new Error("task_type must contain unique supported values");
  return { output: JSON.stringify(checkpoint), metadata: { taskStatus: checkpoint } };
}

function parseObject(command: ParsedCommand): Record<string, unknown> {
  const keys: Partial<Record<ParsedCommand["command_type"], readonly string[]>> = {
    read: ["path", "offset", "limit"],
    glob: ["pattern", "path"],
    grep: ["pattern", "path", "include"],
    task_status: ["task_group", "task_type", "status", "compact_context"],
  };
  const allowed = keys[command.command_type];
  if (!allowed) throw new Error(`${command.command_type} does not use JSON command_line`);
  return parseStrictObject(command, allowed);
}

function patchPaths(diff: string): string[] {
  const paths = [...diff.matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\n]+)$/gm)].map(match => match[1]!).filter(path => path !== "/dev/null");
  if (paths.some(path => path.startsWith("/") || path.split("/").includes(".."))) throw new Error("patch path escapes workspace");
  return [...new Set(paths)];
}

function boundedString(value: unknown, field: string, maximum: number): string {
  const text = requireString(value, field);
  if (text.length > maximum) throw new Error(`${field} must be at most ${maximum} characters`);
  return text;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  return value as number;
}

class ProcessFailure extends Error {
  constructor(message: string, readonly metadata: Record<string, unknown>) {
    super(message);
  }
}

const MAX_MEDIA_BYTES = 8 * 1_048_576;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_TEXT_CHARS = 40_000;

export function parseMediaRequest(command: ParsedCommand): { path: string; offset: number; limit: number } {
  const parsed = parseStrictObject(command, ["path", "offset", "limit"]);
  return {
    path: requireString(parsed.path, "path"),
    offset: mediaInteger(parsed.offset, "offset", 0, 1_000_000) ?? 0,
    limit: mediaInteger(parsed.limit, "limit", 1, 2_000) ?? 500,
  };
}

export async function executeReadMedia(command: ParsedCommand, root: string): Promise<AdapterResult> {
  const request = parseMediaRequest(command);
  const path = await resolveWorkspacePath(root, request.path);
  const canonicalRoot = await resolveWorkspacePath(root, ".");
  const info = await stat(path);
  if (info.isDirectory()) {
    const entries = (await readdir(path, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(request.offset, request.offset + Math.min(request.limit, 500))
      .map(entry => `${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?"}\t${entry.name}`);
    return { output: entries.join("\n") || "Directory is empty.", metadata: { path: relative(canonicalRoot, path), kind: "directory", entries: entries.length } };
  }
  if (!info.isFile()) throw new Error("read_media path must be a regular file or directory");
  if (info.size > MAX_MEDIA_BYTES) throw new Error(`read_media file exceeds ${MAX_MEDIA_BYTES} bytes`);
  const header = await readPrefix(path, Math.min(info.size, 8_192));
  const mime = detectMime(header);
  if (mime) {
    const bytes = await readFile(path);
    return {
      output: `Attached ${relative(canonicalRoot, path)} (${mime}, ${bytes.byteLength} bytes).`,
      metadata: { path: relative(canonicalRoot, path), kind: "attachment", mime, bytes: bytes.byteLength },
      attachments: [{ type: "file", mime, url: `data:${mime};base64,${bytes.toString("base64")}`, filename: basename(path), byteLength: bytes.byteLength }],
    };
  }
  if (header.includes(0) || /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(new TextDecoder().decode(header))) {
    throw new Error("read_media does not support this binary, SVG, or video format");
  }
  if (info.size > MAX_TEXT_BYTES) throw new Error(`read_media text file exceeds ${MAX_TEXT_BYTES} bytes`);
  const text = await readFile(path, "utf8");
  const output = text.split("\n").slice(request.offset, request.offset + request.limit).join("\n");
  return { output: output.slice(0, MAX_TEXT_CHARS), metadata: { path: relative(canonicalRoot, path), kind: "text", truncated: output.length > MAX_TEXT_CHARS } };
}

function detectMime(header: Uint8Array): string | undefined {
  if (matches(header, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  const ascii = new TextDecoder().decode(header);
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.startsWith("%PDF-")) return "application/pdf";
  return undefined;
}

function matches(value: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => value[index] === byte);
}

async function readPrefix(path: string, length: number): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function mediaInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

const MAX_OUTPUT_CHARS = 40_000;

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly stdoutChars: number;
  readonly stderrChars: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly signal: AbortSignal; readonly stdin?: string; readonly shell?: boolean },
): Promise<ProcessResult> {
  if (options.signal.aborted) throw new DOMException("Command aborted", "AbortError");
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: process.env,
    shell: options.shell ?? false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (options.stdin) child.stdin.end(options.stdin);
  else child.stdin.end();

  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const abort = (): void => terminate(child.pid);
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code ?? 1));
    });
    const [out, err] = await Promise.all([stdout, stderr]);
    if (options.signal.aborted) throw new DOMException("Command aborted", "AbortError");
    return {
      stdout: out.output,
      stderr: err.output,
      exitCode,
      stdoutChars: out.characters,
      stderrChars: err.characters,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
    };
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
}

function collect(stream: NodeJS.ReadableStream): Promise<{ output: string; characters: number; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let characters = 0;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      characters += chunk.length;
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.slice(0, MAX_OUTPUT_CHARS - output.length);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve({ output, characters, truncated: characters > output.length }));
  });
}

function terminate(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {
      return;
    }
  }, 1_000).unref();
}

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
  const marker = "\n… output truncated …\n"
  const retained = Math.max(0, maximum - marker.length)
  const headLength = Math.ceil(retained / 2)
  const tailLength = Math.floor(retained / 2)
  return `${output.slice(0, headLength)}${marker}${output.slice(-tailLength)}`.slice(0, maximum)
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

const MAX_URL_LENGTH = 2_048
const MAX_EXTRACT_BYTES = 1_048_576
const MAX_EXTRACT_CHARS = 40_000
const MAX_DOWNLOAD_BYTES = 10 * 1_048_576
const REQUEST_TIMEOUT_MS = 10_000

export type WebRequest = { url: string; mode: "extract"; path?: never } | { url: string; mode: "download"; path: string }

export type WebDependencies = {
  fetch?: typeof fetch
  lookup?: typeof systemLookup
  timeoutMs?: number
}

export function parseWebRequest(command: ParsedCommand): WebRequest {
  const parsed = parseStrictObject(command, ["url", "mode", "path"])
  const url = requireString(parsed.url, "url")
  if (url.length > MAX_URL_LENGTH) throw new Error(`url must be at most ${MAX_URL_LENGTH} characters`)
  if (parsed.mode === "extract") {
    if (parsed.path !== undefined) throw new Error("web_discover extract does not accept path")
    return { url, mode: "extract" }
  }
  if (parsed.mode === "download") {
    return { url, mode: "download", path: requireString(parsed.path, "path") }
  }
  throw new Error("web_discover mode must be extract or download")
}

export async function validateWebPermission(
  command: ParsedCommand,
  root: string,
  dependencies: WebDependencies = {}
): Promise<string[]> {
  const request = parseWebRequest(command)
  const url = await validatePublicUrl(request.url, dependencies.lookup)
  if (request.mode === "extract") return [url.href]
  const destination = await resolveWorkspacePath(root, request.path)
  await assertNewDestination(destination)
  return [url.href, destination]
}

export async function executeWebDiscover(
  command: ParsedCommand,
  root: string,
  signal: AbortSignal,
  dependencies: WebDependencies = {}
): Promise<AdapterResult> {
  const request = parseWebRequest(command)
  const url = await validatePublicUrl(request.url, dependencies.lookup)
  // Re-resolve immediately before I/O to reject a changed public/private DNS answer.
  await assertPublicHost(url.hostname, dependencies.lookup)
  const timeout = AbortSignal.timeout(dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  const response = await (dependencies.fetch ?? fetch)(url, {
    method: "GET",
    redirect: "manual",
    signal: combined,
    credentials: "omit",
    headers: { accept: request.mode === "extract" ? "text/html, application/json, application/xml, text/plain" : "*/*" },
  })
  if (response.status >= 300 && response.status < 400) throw new Error("web_discover redirects are not followed")
  if (!response.ok) throw new Error(`web_discover request failed with HTTP ${response.status}`)

  if (request.mode === "extract") {
    assertContentLength(response, MAX_EXTRACT_BYTES)
    const bytes = await readResponseBounded(response, MAX_EXTRACT_BYTES)
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
    if (!isExtractable(contentType)) throw new Error(`web_discover cannot extract content type: ${contentType || "unknown"}`)
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    const output = contentType === "text/html" ? htmlToText(decoded) : decoded
    return {
      output: output.slice(0, MAX_EXTRACT_CHARS) || "No extractable text.",
      metadata: { url: url.href, mode: request.mode, contentType, bytes: bytes.byteLength, truncated: output.length > MAX_EXTRACT_CHARS },
    }
  }

  const destination = await resolveWorkspacePath(root, request.path)
  await assertNewDestination(destination)
  assertContentLength(response, MAX_DOWNLOAD_BYTES)
  let file: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    file = await open(destination, "wx")
    created = true
    const reader = response.body?.getReader()
    if (!reader) throw new Error("web_discover response has no body")
    let written = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      written += chunk.value.byteLength
      if (written > MAX_DOWNLOAD_BYTES) {
        await reader.cancel()
        throw new Error(`web_discover download exceeds ${MAX_DOWNLOAD_BYTES} bytes`)
      }
      await file.write(chunk.value)
    }
    await file.close()
    file = undefined
    const canonicalRoot = await resolveWorkspacePath(root, ".")
    return { output: `Downloaded ${written} bytes to ${relative(canonicalRoot, destination)}.`, metadata: { url: url.href, mode: request.mode, path: relative(canonicalRoot, destination), bytes: written } }
  } catch (error) {
    await file?.close().catch(() => undefined)
    if (created) await unlink(destination).catch(() => undefined)
    throw error
  }
}

async function validatePublicUrl(raw: string, lookup: WebDependencies["lookup"]): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error("url must be an absolute HTTP or HTTPS URL") }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url protocol must be http or https")
  if (url.username || url.password) throw new Error("url credentials are not allowed")
  if (url.hash) throw new Error("url fragments are not allowed")
  await assertPublicHost(url.hostname, lookup)
  return url
}

async function assertPublicHost(hostname: string, lookup: WebDependencies["lookup"]): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/\.$/, "")
  const specialUse = ["localhost", "local", "internal", "home.arpa", "onion", "invalid", "test"]
  if (specialUse.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))) {
    throw new Error("url host must be public")
  }
  if (isIP(normalized)) throw new Error("IP literal URL hosts are not allowed")
  const addresses = await (lookup ?? systemLookup)(normalized, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("url host resolved to a private or reserved address")
  }
}

function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    const value = address.toLowerCase()
    return (value.startsWith("2") || value.startsWith("3")) && !value.startsWith("2001:db8:")
  }
  const octets = address.split(".").map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a = 0, b = 0] = octets
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 88) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51) || (a === 203 && b === 0))
}

function assertContentLength(response: Response, maximum: number): void {
  const value = response.headers.get("content-length")
  if (value !== null && Number(value) > maximum) throw new Error(`web_discover response exceeds ${maximum} bytes`)
}

async function readResponseBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    length += chunk.value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new Error(`web_discover response exceeds ${maximum} bytes`)
    }
    chunks.push(chunk.value)
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

function isExtractable(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/xml" || contentType.endsWith("+json") || contentType.endsWith("+xml")
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
}

async function assertNewDestination(path: string): Promise<void> {
  try {
    await stat(path)
    throw new Error("web_discover download destination already exists")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  const parent = await stat(dirname(path))
  if (!parent.isDirectory()) throw new Error("web_discover download parent must be an existing directory")
}
