import { createTool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import type { Workspace } from "@mastra/core/workspace";
import {
  COMMAND_TYPES,
  commandRequiresApproval,
  executionClass,
  parseCommands,
  runCommandSchedule,
  type AdapterResult,
  type CommandInput,
  type CommandPhase,
  type CommandRunTrace,
  type CommandTraceUpdate,
  type ParsedCommand,
} from "@rlabs/agent-tools";
import { z } from "zod";

const MAX_RESULT_CHARS = 20_000;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 20 * 1_048_576;
const SANDBOX_COMMAND_RESULT_PREFIX = "__MASTRA_TOOLKIT_COMMAND_RESULT__";

const inputSchema = z.object({
  description: z.string().min(1).max(4_000).regex(/^[^\r\n]+$/),
  commands: z.array(z.object({
    command_type: z.enum(COMMAND_TYPES),
    command_line: z.string().min(1),
    step: z.number().int().positive(),
    timeout_ms: z.number().int().min(100).max(300_000).optional(),
  }).strict()).min(1).max(20),
});

const outputSchema = z.object({
  version: z.literal(1),
  description: z.string(),
  commandRun: z.unknown().optional(),
  results: z.array(z.object({
    status: z.enum(["completed", "failed", "denied", "cancelled", "timed_out"]),
    output: z.string(),
  }).passthrough()),
  attachments: z.array(z.object({
    type: z.string(),
    mime: z.string(),
    url: z.string(),
    filename: z.string().optional(),
  }).passthrough()),
});

export interface SandboxCommandRunAuthorizationContext {
  readonly requestContext: RequestContext;
  readonly workspace?: Workspace;
}

export interface SandboxCommandRunToolOptions {
  readonly authorize?: (context: SandboxCommandRunAuthorizationContext) => Promise<void> | void;
}

export function createSandboxCommandRunTool(options: SandboxCommandRunToolOptions = {}) {
  return createTool({
    id: "command_run",
    description: "Run 1–20 permission-gated repository commands inside the active workspace sandbox.",
    inputSchema,
    outputSchema,
    requireApproval: input => parseCommands(input.commands).some(commandRequiresApproval),
    background: { enabled: true },
    mcp: { annotations: { title: "Command Run", readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    execute: async (input, context) => {
      await options.authorize?.({
        requestContext: context.requestContext,
        ...(context.workspace ? { workspace: context.workspace } : {}),
      });
      if (!context.workspace) throw new Error("command_run requires an active sandbox workspace");
      const [filesystem, sandbox] = await Promise.all([
        context.workspace.resolveFilesystem({ requestContext: context.requestContext }),
        context.workspace.resolveSandbox({ requestContext: context.requestContext }),
      ]);
      if (!filesystem?.basePath || !sandbox?.executeCommand) {
        throw new Error("command_run requires an active sandbox workspace");
      }
      const commands = parseCommands(input.commands as CommandInput[]);
      let latestTrace: CommandRunTrace | undefined;
      const results = await runCommandSchedule(commands, {
        signal: context.abortSignal ?? new AbortController().signal,
        ask: async () => undefined,
        execute: (command, signal, update) => executeSandboxCommand(
          command,
          filesystem.basePath!,
          sandbox.executeCommand!.bind(sandbox),
          signal,
          update,
        ),
        executionClass,
        onTrace: trace => { latestTrace = trace; },
        maxOutputChars: MAX_RESULT_CHARS,
        maxAttachments: MAX_ATTACHMENTS,
        maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      });
      return {
        version: 1 as const,
        description: input.description,
        commandRun: latestTrace,
        results,
        attachments: results.flatMap(result => result.attachments ?? []).map(({ byteLength: _, ...attachment }) => attachment),
      };
    },
  });
}

type ExecuteSandboxCommand = (
  command: string,
  args?: string[],
  options?: {
    cwd?: string;
    timeout?: number;
    abortSignal?: AbortSignal;
    maxRetainedBytes?: number;
  },
) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}>;

async function executeSandboxCommand(
  command: ParsedCommand,
  workdir: string,
  execute: ExecuteSandboxCommand,
  signal: AbortSignal,
  update: (phase: CommandPhase, update?: CommandTraceUpdate) => void,
): Promise<AdapterResult> {
  update("running");
  if (command.command_type !== "shell") {
    const result = await execute("node", [
      "--input-type=module",
      "--eval",
      SANDBOX_COMMAND_RUNNER,
      Buffer.from(JSON.stringify(command)).toString("base64url"),
    ], {
      cwd: workdir,
      ...(command.timeout_ms ? { timeout: command.timeout_ms } : {}),
      abortSignal: signal,
      maxRetainedBytes: MAX_ATTACHMENT_BYTES + MAX_RESULT_CHARS,
    });
    if (result.exitCode !== 0) throw new SandboxCommandFailure(result.stderr || result.stdout, result);
    return parseSandboxRunnerResult(result.stdout);
  }
  if (/(^|[^&])&($|[^&])|\b(?:nohup|disown)\b/.test(command.command_line)) {
    throw new Error("background shell execution is not supported");
  }
  const result = await execute("/bin/sh", ["-lc", command.command_line], {
    cwd: workdir,
    ...(command.timeout_ms ? { timeout: command.timeout_ms } : {}),
    abortSignal: signal,
    maxRetainedBytes: MAX_RESULT_CHARS,
  });
  if (result.exitCode !== 0) throw new SandboxCommandFailure(result.stderr || result.stdout, result);
  return {
    output: result.stdout || result.stderr || "Command completed.",
    metadata: {
      originalCommand: command.command_line,
      executedCommand: command.command_line,
      rewriteStatus: "sandbox",
      exitCode: result.exitCode,
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
      stdoutTruncated: result.stdoutTruncated ?? false,
      stderrTruncated: result.stderrTruncated ?? false,
    },
  };
}

function parseSandboxRunnerResult(stdout: string): AdapterResult {
  const marker = stdout.lastIndexOf(SANDBOX_COMMAND_RESULT_PREFIX);
  if (marker < 0) throw new Error("Sandbox command runner returned no structured result");
  const encoded = stdout.slice(marker + SANDBOX_COMMAND_RESULT_PREFIX.length).trim().split("\n", 1)[0];
  if (!encoded) throw new Error("Sandbox command runner returned an empty result");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Sandbox command runner returned an invalid result");
  }
  const envelope = parsed as { ok?: unknown; result?: unknown; error?: unknown };
  if (envelope.ok === false) {
    const message = typeof envelope.error === "string" && envelope.error
      ? envelope.error
      : "Sandbox command failed";
    throw new SandboxCommandFailure(message, { runnerError: true });
  }
  if (envelope.ok !== true || !envelope.result || typeof envelope.result !== "object") {
    throw new Error("Sandbox command runner returned an invalid envelope");
  }
  const result = envelope.result as AdapterResult;
  if (typeof result.output !== "string") throw new Error("Sandbox command runner returned invalid output");
  return result;
}

const SANDBOX_COMMAND_RUNNER = String.raw`
import { glob, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const RESULT_PREFIX = "${SANDBOX_COMMAND_RESULT_PREFIX}";
const MAX_READ_CHARS = 40_000;
const MAX_PROCESS_OUTPUT_CHARS = 40_000;
const activeChildren = new Set();
const command = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const root = await realpath(process.cwd());

function terminateChild(child, signal) {
  if (!child.pid) return;
  try { process.kill(child.pid, signal); } catch {}
}

process.once("SIGTERM", () => {
  for (const child of activeChildren) terminateChild(child, "SIGTERM");
  setTimeout(() => {
    for (const child of activeChildren) terminateChild(child, "SIGKILL");
    setTimeout(() => process.exit(143), 25).unref();
  }, 25).unref();
});

function assertWithinRoot(candidate) {
  const child = relative(root, candidate);
  if (child === "" || (!child.startsWith(".." + sep) && child !== ".." && !isAbsolute(child))) return;
  throw new Error("path escapes workspace");
}

async function resolveExistingPath(requestedPath) {
  if (requestedPath.includes("\\0")) throw new Error("paths cannot contain null bytes");
  const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
  assertWithinRoot(candidate);
  const canonical = await realpath(candidate);
  assertWithinRoot(canonical);
  return { candidate: canonical, relativePath: relative(root, canonical) || "." };
}

async function resolveNewPath(requestedPath) {
  if (requestedPath.includes("\\0")) throw new Error("paths cannot contain null bytes");
  const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
  assertWithinRoot(candidate);
  const parent = await realpath(dirname(candidate));
  assertWithinRoot(parent);
  try {
    await stat(candidate);
    throw new Error("destination already exists");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return { candidate, relativePath: relative(root, candidate) };
}

function parseObject(value, allowed) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("command_line must be a JSON object");
  for (const key of Object.keys(parsed)) if (!allowed.includes(key)) throw new Error("Unknown command field: " + key);
  return parsed;
}

function integer(value, field, minimum, maximum) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(field + " is out of range");
  return value;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(field + " must be a non-empty string");
  return value;
}

function runProcess(program, args, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(program, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutChars = 0;
    let stderrChars = 0;
    activeChildren.add(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdoutChars += chunk.length;
      if (stdout.length < MAX_PROCESS_OUTPUT_CHARS) stdout += chunk.slice(0, MAX_PROCESS_OUTPUT_CHARS - stdout.length);
    });
    child.stderr.on("data", chunk => {
      stderrChars += chunk.length;
      if (stderr.length < MAX_PROCESS_OUTPUT_CHARS) stderr += chunk.slice(0, MAX_PROCESS_OUTPUT_CHARS - stderr.length);
    });
    child.on("error", rejectRun);
    child.on("close", exitCode => {
      activeChildren.delete(child);
      resolveRun({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        stdoutChars,
        stderrChars,
        stdoutTruncated: stdoutChars > stdout.length,
        stderrTruncated: stderrChars > stderr.length,
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function executeRead() {
  const input = parseObject(command.command_line, ["path", "offset", "limit"]);
  if (typeof input.path !== "string" || !input.path) throw new Error("path must be a non-empty string");
  const path = await resolveExistingPath(input.path);
  if (!(await stat(path.candidate)).isFile()) throw new Error("read path must be a file");
  const offset = integer(input.offset, "offset", 0, 1_000_000) ?? 0;
  const limit = integer(input.limit, "limit", 1, 2_000) ?? 500;
  const value = (await readFile(path.candidate, "utf8")).split("\n").slice(offset, offset + limit).join("\n");
  return {
    output: value.slice(0, MAX_READ_CHARS),
    metadata: { path: path.relativePath, offset, truncated: value.length > MAX_READ_CHARS },
  };
}

async function executeGlob() {
  const input = parseObject(command.command_line, ["pattern", "path"]);
  const pattern = requiredString(input.pattern, "pattern");
  const base = await resolveExistingPath(typeof input.path === "string" ? input.path : ".");
  if (!(await stat(base.candidate)).isDirectory()) throw new Error("glob path must be a directory");
  const matches = [];
  for await (const match of glob(pattern, { cwd: base.candidate, exclude: ["node_modules/**", ".git/**"] })) {
    const resolved = await resolveExistingPath([relative(root, base.candidate), match].filter(Boolean).join("/"));
    matches.push(resolved.relativePath);
    if (matches.length === 200) break;
  }
  matches.sort();
  return { output: matches.join("\n") || "No matches.", metadata: { matches: matches.length, truncated: matches.length === 200 } };
}

async function executeGrep() {
  const input = parseObject(command.command_line, ["pattern", "path", "include"]);
  const target = await resolveExistingPath(typeof input.path === "string" ? input.path : ".");
  const args = ["--line-number", "--no-heading", "--color", "never"];
  if (input.include !== undefined) args.push("--glob", requiredString(input.include, "include"));
  args.push("--", requiredString(input.pattern, "pattern"), target.candidate);
  const result = await runProcess("rg", args);
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr || "rg failed");
  return {
    output: result.stdout || "No matches.",
    metadata: {
      exitCode: result.exitCode,
      stdoutChars: result.stdoutChars,
      stderrChars: result.stderrChars,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      matched: result.exitCode === 0,
    },
  };
}

function patchPaths(diff) {
  const paths = [...diff.matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\n]+)$/gm)]
    .map(match => match[1])
    .filter(path => path !== "/dev/null");
  if (paths.some(path => path.startsWith("/") || path.split("/").includes(".."))) {
    throw new Error("patch path escapes workspace");
  }
  return [...new Set(paths)];
}

async function assertSafePatchPath(path) {
  const candidate = resolve(root, path);
  assertWithinRoot(candidate);
  try {
    assertWithinRoot(await realpath(candidate));
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    assertWithinRoot(await realpath(dirname(candidate)));
  }
}

async function executePatch() {
  const paths = patchPaths(command.command_line);
  if (paths.length === 0) throw new Error("apply_patch requires unified diff file headers");
  await Promise.all(paths.map(assertSafePatchPath));
  const check = await runProcess("git", ["apply", "--check", "--whitespace=nowarn", "-"], command.command_line);
  if (check.exitCode !== 0) throw new Error(check.stderr || "patch validation failed");
  const applied = await runProcess("git", ["apply", "--whitespace=nowarn", "-"], command.command_line);
  if (applied.exitCode !== 0) throw new Error(applied.stderr || "patch application failed");
  return { output: "Applied patch to " + paths.length + " path(s).", metadata: { paths } };
}

function executeTaskStatus() {
  const input = parseObject(command.command_line, ["task_group", "task_type", "status", "compact_context"]);
  const taskTypes = new Set(["implementation", "new_build", "debugging", "refactoring", "architecture", "review", "research", "data_research", "visual_inspection", "frontend", "website", "interactive_3d", "editorial", "operations"]);
  if (!["doing", "question", "done"].includes(input.status)) throw new Error("status must be doing, question, or done");
  if (!Array.isArray(input.task_type) || input.task_type.length === 0 || input.task_type.some(value => !taskTypes.has(value))) {
    throw new Error("task_type must contain supported values");
  }
  const uniqueTypes = [...new Set(input.task_type)];
  if (uniqueTypes.length !== input.task_type.length) throw new Error("task_type must contain unique supported values");
  const taskGroup = requiredString(input.task_group, "task_group");
  if (taskGroup.length > 200) throw new Error("task_group must be at most 200 characters");
  if (typeof input.compact_context === "string" && input.compact_context.length > 4_000) {
    throw new Error("compact_context must be at most 4000 characters");
  }
  const checkpoint = {
    version: 1,
    task_group: taskGroup,
    task_type: uniqueTypes,
    status: input.status,
    ...(typeof input.compact_context === "string" ? { compact_context: input.compact_context } : {}),
  };
  return { output: JSON.stringify(checkpoint), metadata: { taskStatus: checkpoint } };
}

function detectMime(header) {
  const starts = prefix => prefix.every((value, index) => header[index] === value);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  const ascii = new TextDecoder().decode(header);
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.startsWith("%PDF-")) return "application/pdf";
}

async function executeReadMedia() {
  const input = parseObject(command.command_line, ["path", "offset", "limit"]);
  const target = await resolveExistingPath(requiredString(input.path, "path"));
  const offset = integer(input.offset, "offset", 0, 1_000_000) ?? 0;
  const limit = integer(input.limit, "limit", 1, 2_000) ?? 500;
  const info = await stat(target.candidate);
  if (info.isDirectory()) {
    const entries = (await readdir(target.candidate, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(offset, offset + Math.min(limit, 500))
      .map(entry => (entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?") + "\t" + entry.name);
    return { output: entries.join("\n") || "Directory is empty.", metadata: { path: target.relativePath, kind: "directory", entries: entries.length } };
  }
  if (!info.isFile()) throw new Error("read_media path must be a regular file or directory");
  if (info.size > 8 * 1_048_576) throw new Error("read_media file exceeds 8388608 bytes");
  const handle = await open(target.candidate, "r");
  const header = Buffer.alloc(Math.min(info.size, 8192));
  await handle.read(header, 0, header.length, 0);
  await handle.close();
  const mime = detectMime(header);
  if (mime) {
    const bytes = await readFile(target.candidate);
    return {
      output: "Attached " + target.relativePath + " (" + mime + ", " + bytes.byteLength + " bytes).",
      metadata: { path: target.relativePath, kind: "attachment", mime, bytes: bytes.byteLength },
      attachments: [{ type: "file", mime, url: "data:" + mime + ";base64," + bytes.toString("base64"), filename: basename(target.candidate), byteLength: bytes.byteLength }],
    };
  }
  const headerText = new TextDecoder().decode(header);
  if (header.includes(0) || /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(headerText)) {
    throw new Error("read_media does not support this binary, SVG, or video format");
  }
  if (info.size > 1_048_576) throw new Error("read_media text file exceeds 1048576 bytes");
  const text = await readFile(target.candidate, "utf8");
  const output = text.split("\n").slice(offset, offset + limit).join("\n");
  return { output: output.slice(0, 40_000), metadata: { path: target.relativePath, kind: "text", truncated: output.length > 40_000 } };
}

function isPublicAddress(address) {
  if (address.includes(":")) {
    const value = address.toLowerCase();
    return (value.startsWith("2") || value.startsWith("3")) && !value.startsWith("2001:db8:");
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a = 0, b = 0] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 88) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51) || (a === 203 && b === 0));
}

async function validatePublicHostname(rawHostname) {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, "");
  if (isIP(hostname)) throw new Error("IP literal URL hosts are not allowed");
  const special = ["localhost", "local", "internal", "home.arpa", "onion", "invalid", "test"];
  if (special.some(suffix => hostname === suffix || hostname.endsWith("." + suffix))) throw new Error("url host must be public");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error("url host must resolve only to public addresses");
}

async function validatePublicUrl(raw) {
  if (raw.length > 2_048) throw new Error("url must be at most 2048 characters");
  let url;
  try { url = new URL(raw); } catch { throw new Error("url must be an absolute HTTP or HTTPS URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("url protocol must be http or https");
  if (url.username || url.password || url.hash) throw new Error("url credentials and fragments are not allowed");
  await validatePublicHostname(url.hostname);
  return url;
}

async function readResponse(response, maximum) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximum) throw new Error("web_discover response is too large");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new Error("web_discover response is too large");
    }
    chunks.push(chunk.value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function executeWebDiscover() {
  const input = parseObject(command.command_line, ["url", "mode", "path"]);
  if (input.mode !== "extract" && input.mode !== "download") throw new Error("web_discover mode must be extract or download");
  const url = await validatePublicUrl(requiredString(input.url, "url"));
  await validatePublicHostname(url.hostname);
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: input.mode === "extract" ? "text/html, application/json, application/xml, text/plain" : "*/*" },
  });
  if (response.status >= 300 && response.status < 400) throw new Error("web_discover redirects are not followed");
  if (!response.ok) throw new Error("web_discover request failed with HTTP " + response.status);
  if (input.mode === "extract") {
    if (input.path !== undefined) throw new Error("web_discover extract does not accept path");
    const bytes = await readResponse(response, 1_048_576);
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    const extractable = contentType.startsWith("text/") || ["application/json", "application/xml"].includes(contentType) || contentType.endsWith("+json") || contentType.endsWith("+xml");
    if (!extractable) throw new Error("web_discover cannot extract content type: " + (contentType || "unknown"));
    let output = new TextDecoder().decode(bytes);
    if (contentType === "text/html") output = output
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, " ")
      .trim();
    return { output: output.slice(0, 40_000) || "No extractable text.", metadata: { url: url.href, mode: input.mode, contentType, bytes: bytes.byteLength, truncated: output.length > 40_000 } };
  }
  const destination = await resolveNewPath(requiredString(input.path, "path"));
  const bytes = await readResponse(response, 10 * 1_048_576);
  const handle = await open(destination.candidate, "wx");
  try { await handle.write(bytes); } finally { await handle.close(); }
  return { output: "Downloaded " + bytes.byteLength + " bytes to " + destination.relativePath + ".", metadata: { url: url.href, mode: input.mode, path: destination.relativePath, bytes: bytes.byteLength } };
}

try {
  let result;
  if (command.command_type === "read") result = await executeRead();
  else if (command.command_type === "glob") result = await executeGlob();
  else if (command.command_type === "grep") result = await executeGrep();
  else if (command.command_type === "apply_patch") result = await executePatch();
  else if (command.command_type === "task_status") result = executeTaskStatus();
  else if (command.command_type === "read_media") result = await executeReadMedia();
  else if (command.command_type === "web_discover") result = await executeWebDiscover();
  else throw new Error("Sandbox command type is not implemented: " + command.command_type);
  process.stdout.write(RESULT_PREFIX + Buffer.from(JSON.stringify({ ok: true, result })).toString("base64url") + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : "Sandbox command failed";
  process.stdout.write(RESULT_PREFIX + Buffer.from(JSON.stringify({ ok: false, error: message.slice(0, 1_000) })).toString("base64url") + "\n");
}
`;

class SandboxCommandFailure extends Error {
  constructor(message: string, readonly metadata: Record<string, unknown>) {
    super(message);
    this.name = "SandboxCommandFailure";
  }
}
