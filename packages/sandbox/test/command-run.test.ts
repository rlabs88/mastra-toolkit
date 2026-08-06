import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { describe, expect, test } from "vitest";
import {
  createLocalSandboxMachine,
  createSandboxCommandRunTool,
  DEFAULT_SANDBOX_SPEC_PATH,
  loadSandboxSpec,
} from "../src/index.js";

describe("sandbox command_run", () => {
  test("fails closed when no active sandbox workspace is bound", async () => {
    await expect(createSandboxCommandRunTool().execute?.({
      description: "do not fall back to the host",
      commands: [{ command_type: "shell", command_line: "pwd", step: 1 }],
    }, {
      requestContext: new RequestContext(),
    } as never)).rejects.toThrow(/active sandbox workspace/i);
  });

  test("requests approval when a command batch contains a mutation", async () => {
    const tool = createSandboxCommandRunTool();
    const approval = tool.requireApproval;
    if (typeof approval !== "function") throw new Error("dynamic approval is not configured");

    const readOnly = await approval({
      description: "read",
      commands: [{ command_type: "read", command_line: "{\"path\":\"README.md\"}", step: 1 }],
    }, {} as never);
    const mutating = await approval({
      description: "shell",
      commands: [{ command_type: "shell", command_line: "true", step: 1 }],
    }, {} as never);

    expect(readOnly).toBe(false);
    expect(mutating).toBe(true);
  });

  test("executes shell commands through the active workspace sandbox", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const tool = createSandboxCommandRunTool();
    const result = await tool.execute?.({
      description: "inspect the checkout",
      commands: [{ command_type: "shell", command_line: "pwd", step: 1 }],
    }, {
      requestContext: new RequestContext(),
      workspace: {
        resolveFilesystem: async () => ({ basePath: "/workspace/project" }),
        resolveSandbox: async () => ({
          provider: "fixture",
          executeCommand: async (command: string, args: string[], options?: { cwd?: string }) => {
            calls.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
            return {
              success: true,
              exitCode: 0,
              stdout: "/workspace/project\n",
              stderr: "",
              executionTimeMs: 1,
            };
          },
        }),
      },
    } as never);

    expect(calls).toEqual([{
      command: "/bin/sh",
      args: ["-lc", "pwd"],
      cwd: "/workspace/project",
    }]);
    expect(result).toMatchObject({
      version: 1,
      results: [{ status: "completed", output: "/workspace/project\n" }],
    });
  });

  test("bounds oversized sandbox output and records truncation", async () => {
    const result = await createSandboxCommandRunTool().execute?.({
      description: "bound sandbox output",
      commands: [{ command_type: "shell", command_line: "generate-output", step: 1 }],
    }, {
      requestContext: new RequestContext(),
      workspace: {
        resolveFilesystem: async () => ({ basePath: "/workspace/project" }),
        resolveSandbox: async () => ({
          executeCommand: async () => ({
            exitCode: 0,
            stdout: "x".repeat(25_000),
            stderr: "",
            stdoutTruncated: false,
          }),
        }),
      },
    } as never);
    if (!result || !("results" in result)) throw new Error("command_run returned no output");

    expect(result.results[0]?.output).toHaveLength(20_000);
    expect(result.results[0]?.output).toMatch(/output truncated$/);
    const trace = result.commandRun as { records?: Array<Record<string, unknown>> } | undefined;
    expect(trace?.records?.[0]).toMatchObject({ stdoutChars: 25_000, stdoutTruncated: true });
  });

  test("rejects background shell execution before invoking the sandbox", async () => {
    let invoked = false;
    const result = await createSandboxCommandRunTool().execute?.({
      description: "reject background work",
      commands: [{ command_type: "shell", command_line: "true &", step: 1 }],
    }, {
      requestContext: new RequestContext(),
      workspace: {
        resolveFilesystem: async () => ({ basePath: "/workspace/project" }),
        resolveSandbox: async () => ({
          executeCommand: async () => {
            invoked = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
      },
    } as never);
    if (!result || !("results" in result)) throw new Error("command_run returned no output");

    expect(invoked).toBe(false);
    expect(result.results[0]).toMatchObject({ status: "failed" });
    expect(result.results[0]?.output).toMatch(/background shell execution/i);
  });

  test("propagates timeout cancellation to the sandbox and cancels later steps", async () => {
    let sandboxAborted = false;
    const result = await createSandboxCommandRunTool().execute?.({
      description: "time out sandbox work",
      commands: [
        { command_type: "shell", command_line: "wait", step: 1, timeout_ms: 100 },
        { command_type: "read", command_line: JSON.stringify({ path: "never.txt" }), step: 2 },
      ],
    }, {
      requestContext: new RequestContext(),
      workspace: {
        resolveFilesystem: async () => ({ basePath: "/workspace/project" }),
        resolveSandbox: async () => ({
          executeCommand: async (_command: string, _args: string[], options: { abortSignal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              options.abortSignal?.addEventListener("abort", () => {
                sandboxAborted = true;
                reject(new DOMException("aborted", "AbortError"));
              }, { once: true });
            }),
        }),
      },
    } as never);
    if (!result || !("results" in result)) throw new Error("command_run returned no output");

    expect(sandboxAborted).toBe(true);
    expect(result.results.map(item => item.status)).toEqual(["timed_out", "cancelled"]);
  });

  test("kills an inner sandbox runner child that ignores SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-command-cancellation-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    await symlink(process.execPath, join(bin, "node"));
    await writeFile(join(bin, "rg"), "#!/bin/sh\ntrap '' TERM\nprintf '%s' $$ > child.pid\nwhile :; do :; done\n");
    await chmod(join(bin, "rg"), 0o755);
    const sandbox = new LocalSandbox({
      workingDirectory: root,
      isolation: "none",
      env: { PATH: bin },
    });
    const workspace = new Workspace({
      id: "sandbox-command-cancellation-test",
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox,
    });
    await workspace.init();
    const cancellation = new AbortController();
    let childPid: number | undefined;

    try {
      const execution = createSandboxCommandRunTool().execute?.({
        description: "cancel an inner process",
        commands: [{ command_type: "grep", command_line: JSON.stringify({ pattern: "never", path: "." }), step: 1 }],
      }, { requestContext: new RequestContext(), workspace, abortSignal: cancellation.signal } as never);
      childPid = Number(await waitForFile(join(root, "child.pid")));
      cancellation.abort();
      const result = await execution;
      if (!result || !("results" in result)) throw new Error("command_run returned no output");

      expect(result.results[0]?.status).toBe("cancelled");
      await waitForProcessExit(childPid);
      expect(isProcessRunning(childPid)).toBe(false);
    } finally {
      if (childPid && isProcessRunning(childPid)) {
        try { process.kill(-childPid, "SIGKILL"); } catch {}
        try { process.kill(childPid, "SIGKILL"); } catch {}
      }
      await workspace.destroy();
    }
  }, 30_000);

  test("reads files through a Local sandbox instead of the host command adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-command-run-"));
    await writeFile(join(root, "README.md"), "sandbox-owned\nsecond line\n");
    const workspace = new Workspace({
      id: "sandbox-command-run-test",
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox: createLocalSandboxMachine({
        workspaceRoot: root,
        specification: loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH),
      }),
    });
    await workspace.init();

    try {
      const result = await createSandboxCommandRunTool().execute?.({
        description: "read the checkout",
        commands: [{
          command_type: "read",
          command_line: JSON.stringify({ path: "README.md", offset: 1, limit: 1 }),
          step: 1,
        }],
      }, { requestContext: new RequestContext(), workspace } as never);

      expect(result).toMatchObject({
        results: [{
          status: "completed",
          output: "second line",
          metadata: { path: "README.md", offset: 1 },
        }],
      });
    } finally {
      await workspace.destroy();
    }
  });

  test("runs the repository command surface inside the Local sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-command-surface-"));
    await writeFile(join(root, "notes.txt"), "alpha\nbeta\n");
    const workspace = new Workspace({
      id: "sandbox-command-surface-test",
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox: createLocalSandboxMachine({
        workspaceRoot: root,
        specification: loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH),
      }),
    });
    await workspace.init();

    try {
      const result = await createSandboxCommandRunTool().execute?.({
        description: "exercise sandbox commands",
        commands: [
          { command_type: "glob", command_line: JSON.stringify({ pattern: "*.txt" }), step: 1 },
          { command_type: "grep", command_line: JSON.stringify({ pattern: "beta", path: "." }), step: 1 },
          {
            command_type: "apply_patch",
            command_line: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n",
            step: 2,
          },
          { command_type: "read_media", command_line: JSON.stringify({ path: "notes.txt" }), step: 3 },
          {
            command_type: "task_status",
            command_line: JSON.stringify({ task_group: "sandbox", task_type: ["implementation"], status: "done" }),
            step: 3,
          },
        ],
      }, { requestContext: new RequestContext(), workspace } as never);
      if (!result || !("results" in result)) throw new Error("command_run returned no output");

      expect(result?.results.map(item => item.status)).toEqual([
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
      ]);
      expect(result?.results[0]?.output).toContain("notes.txt");
      expect(result?.results[1]?.output).toContain("beta");
      expect(result.results[1]?.metadata).not.toHaveProperty("stdout");
      expect(result.results[1]?.metadata).not.toHaveProperty("stderr");
      expect(result?.results[3]?.output).toBe("alpha\ngamma\n");
      expect(JSON.parse(result?.results[4]?.output ?? "{}")).toMatchObject({ status: "done" });
      await expect(readFile(join(root, "notes.txt"), "utf8")).resolves.toBe("alpha\ngamma\n");
    } finally {
      await workspace.destroy();
    }
  });

  test("rejects a whitespace-only task group like the canonical parser", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-command-task-status-"));
    const workspace = new Workspace({
      id: "sandbox-command-task-status-test",
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox: createLocalSandboxMachine({
        workspaceRoot: root,
        specification: loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH),
      }),
    });
    await workspace.init();

    try {
      const result = await createSandboxCommandRunTool().execute?.({
        description: "reject an empty task group",
        commands: [{
          command_type: "task_status",
          command_line: JSON.stringify({ task_group: "   ", task_type: ["implementation"], status: "done" }),
          step: 1,
        }],
      }, { requestContext: new RequestContext(), workspace } as never);
      if (!result || !("results" in result)) throw new Error("command_run returned no output");

      expect(result.results[0]).toMatchObject({ status: "failed" });
      expect(result.results[0]?.output).toMatch(/non-empty string/i);
    } finally {
      await workspace.destroy();
    }
  });

  test("validates web targets inside the sandbox before network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-command-web-"));
    const workspace = new Workspace({
      id: "sandbox-command-web-test",
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox: createLocalSandboxMachine({
        workspaceRoot: root,
        specification: loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH),
      }),
    });
    await workspace.init();

    try {
      const result = await createSandboxCommandRunTool().execute?.({
        description: "reject a private target",
        commands: [{
          command_type: "web_discover",
          command_line: JSON.stringify({ url: "http://127.0.0.1/internal", mode: "extract" }),
          step: 1,
        }],
      }, { requestContext: new RequestContext(), workspace } as never);
      if (!result || !("results" in result)) throw new Error("command_run returned no output");

      expect(result?.results[0]).toMatchObject({ status: "failed" });
      expect(result?.results[0]?.output).toMatch(/IP literal|public/i);
    } finally {
      await workspace.destroy();
    }
  });

  test("rejects symlink escapes with a bounded sandbox error", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-command-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "sandbox-command-outside-"));
    await writeFile(join(outside, "secret.txt"), "must-not-leak");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    const workspace = new Workspace({
      id: "sandbox-command-symlink-test",
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox: createLocalSandboxMachine({
        workspaceRoot: root,
        specification: loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH),
      }),
    });
    await workspace.init();

    try {
      const result = await createSandboxCommandRunTool().execute?.({
        description: "reject a symlink escape",
        commands: [{ command_type: "read", command_line: JSON.stringify({ path: "escape.txt" }), step: 1 }],
      }, { requestContext: new RequestContext(), workspace } as never);
      if (!result || !("results" in result)) throw new Error("command_run returned no output");

      expect(result.results[0]).toMatchObject({ status: "failed", output: "path escapes workspace" });
      expect(result.results[0]?.output).not.toContain("must-not-leak");
      expect(result.results[0]?.output).not.toContain("at ");
    } finally {
      await workspace.destroy();
    }
  });

  test("applies new-file patches inside the sandbox root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-command-new-file-"));
    const workspace = new Workspace({
      id: "sandbox-command-new-file-test",
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox: createLocalSandboxMachine({
        workspaceRoot: root,
        specification: loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH),
      }),
    });
    await workspace.init();

    try {
      const result = await createSandboxCommandRunTool().execute?.({
        description: "create a sandbox file",
        commands: [{
          command_type: "apply_patch",
          command_line: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+sandbox-created\n",
          step: 1,
        }],
      }, { requestContext: new RequestContext(), workspace } as never);
      if (!result || !("results" in result)) throw new Error("command_run returned no output");

      expect(result.results[0]).toMatchObject({ status: "completed" });
      await expect(readFile(join(root, "new.txt"), "utf8")).resolves.toBe("sandbox-created\n");
    } finally {
      await workspace.destroy();
    }
  });

  test("rejects SVG media inside the sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-command-svg-"));
    await writeFile(join(root, "unsafe.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    const workspace = new Workspace({
      id: "sandbox-command-svg-test",
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox: createLocalSandboxMachine({
        workspaceRoot: root,
        specification: loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH),
      }),
    });
    await workspace.init();

    try {
      const result = await createSandboxCommandRunTool().execute?.({
        description: "reject SVG media",
        commands: [{ command_type: "read_media", command_line: JSON.stringify({ path: "unsafe.svg" }), step: 1 }],
      }, { requestContext: new RequestContext(), workspace } as never);
      if (!result || !("results" in result)) throw new Error("command_run returned no output");

      expect(result.results[0]).toMatchObject({ status: "failed" });
      expect(result.results[0]?.output).toMatch(/SVG/i);
    } finally {
      await workspace.destroy();
    }
  });

  test("projects image attachments and enforces the aggregate file budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-command-attachments-"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await Promise.all(Array.from({ length: 5 }, (_, index) => writeFile(join(root, `${index}.png`), png)));
    const workspace = new Workspace({
      id: "sandbox-command-attachments-test",
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox: createLocalSandboxMachine({
        workspaceRoot: root,
        specification: loadSandboxSpec(DEFAULT_SANDBOX_SPEC_PATH),
      }),
    });
    await workspace.init();

    try {
      const result = await createSandboxCommandRunTool().execute?.({
        description: "attach bounded images",
        commands: Array.from({ length: 5 }, (_, index) => ({
          command_type: "read_media" as const,
          command_line: JSON.stringify({ path: `${index}.png` }),
          step: 1,
        })),
      }, { requestContext: new RequestContext(), workspace } as never);
      if (!result || !("results" in result)) throw new Error("command_run returned no output");

      expect(result.results.map(item => item.status)).toEqual([
        "completed",
        "completed",
        "completed",
        "completed",
        "failed",
      ]);
      expect(result.attachments).toHaveLength(4);
      expect(result.attachments[0]).toMatchObject({ mime: "image/png", filename: "0.png" });
      expect(result.attachments[0]?.url).toMatch(/^data:image\/png;base64,/);
      expect(result.results[4]?.output).toMatch(/attachments exceed 4 files/i);
    } finally {
      await workspace.destroy();
    }
  });
});

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isProcessRunning(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const status = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    return status !== "" && !status.startsWith("Z");
  } catch {
    return false;
  }
}
