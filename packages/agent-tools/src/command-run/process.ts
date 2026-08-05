import { spawn } from "node:child_process";

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
