import { glob, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { executeReadMedia, parseMediaRequest } from "./media.js";
import { parseStrictObject, requireString } from "./parser.js";
import { resolveWorkspacePath } from "./paths.js";
import { runProcess } from "./process.js";
import { executeWebDiscover, parseWebRequest, validateWebPermission, type WebDependencies } from "./web.js";
import { TASK_TYPES, type AdapterResult, type CommandPhase, type CommandTraceUpdate, type ExecutionClass, type ParsedCommand, type TaskCheckpoint, type TaskType } from "./types.js";

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
