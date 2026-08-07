import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { createWorkspaceTools, LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { SandboxFilesystem } from "@mastra/code-sdk/agents/sandbox-filesystem";
import { loadModelProfile, resolveRuntimeDefaultsV1 } from "@rlabs/runtime-config";
import { createSandboxMachine, loadSandboxConfig } from "@rlabs/sandbox";
import { afterEach, describe, expect, test } from "vitest";
import { createFactoryAgentBundle, ToolkitFactoryIntegration } from "../src/index.js";

let projectRoot: string | undefined;

afterEach(async () => {
  delete process.env.FACTORY_PRIVILEGED_SENTINEL;
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
  projectRoot = undefined;
});

describe("Factory project workflows", () => {
  test("lists and runs only explicitly published project workflows inside the active sandbox workspace", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "rlabs-factory-workflow-"));
    await mkdir(join(projectRoot, ".mastracode", "workflow"), { recursive: true });
    await writeFile(join(projectRoot, ".mastracode", "workflow", "demo.ts"), workflowFixture("demo", true));
    await writeFile(join(projectRoot, ".mastracode", "workflow", "private.ts"), workflowFixture("private", false));
    const canonicalProjectRoot = await realpath(projectRoot);
    process.env.FACTORY_PRIVILEGED_SENTINEL = "must-not-enter-the-sandbox";
    const sandbox = localSandboxMachine(projectRoot);
    if (!sandbox.executeCommand) throw new Error("LocalSandbox command execution is unavailable");
    const sandboxFilesystem = new SandboxFilesystem({
      sandbox: {
        id: sandbox.id,
        executeCommand: (command, args, options) => sandbox.executeCommand!(command, args, options),
      },
      workdir: projectRoot,
    });
    const workspace = new Workspace({
      id: "mfw-factory-project-workflow-test",
      filesystem: sandboxFilesystem,
      sandbox,
    });
    await workspace.init();
    const tools = await factoryIntegration().agentTools();
    const projectWorkflow = tools.project_workflow as {
      requireApproval?: boolean;
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    const streamed: unknown[] = [];
    const context = {
      requestContext: factorySessionRequestContext(),
      workspace,
      writer: { write: async (chunk: unknown) => { streamed.push(chunk); } },
    };

    try {
      expect(projectWorkflow).toBeDefined();
      expect(projectWorkflow.requireApproval).toBe(true);
      const nativeWorkspaceTools = await createWorkspaceTools(workspace, {
        requestContext: context.requestContext,
        workspace,
      });
      await expect(nativeWorkspaceTools.mastra_workspace_execute_command.execute(
        { command: "pwd" },
        { requestContext: context.requestContext, workspace },
      )).resolves.toBe(`${canonicalProjectRoot}\n`);

      await expect(projectWorkflow.execute?.({ action: "list" }, context)).resolves.toEqual({
        workflows: [{ id: "demo", description: "Run demo", metadata: { fixture: true } }],
      });
      const execution = projectWorkflow.execute?.({
        action: "run",
        workflowId: "demo",
        input: { value: " sandbox " },
      }, context);
      await waitForCondition(() => streamed.length > 0);
      await expect(access(join(projectRoot, "workflow-finished.txt"))).rejects.toThrow();
      await expect(execution).resolves.toEqual({
        runId: "demo-run",
        status: "success",
        output: {
          value: "sandbox",
          cwd: canonicalProjectRoot,
          privileged: null,
          requestContextPassed: false,
        },
      });
      expect(streamed).toEqual([{ type: "fixture", value: "sandbox" }]);
      await expect(readFile(join(projectRoot, "workflow-ran.txt"), "utf8")).resolves.toBe("demo:sandbox");
      await expect(projectWorkflow.execute?.({
        action: "run",
        workflowId: "private",
        input: {},
      }, context)).rejects.toThrow(/not published/i);
    } finally {
      await workspace.destroy();
    }
  }, 30_000);

  test("forwards cancellation to the active sandbox workflow run", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "rlabs-factory-workflow-cancel-"));
    await mkdir(join(projectRoot, ".mastracode", "workflow"), { recursive: true });
    await writeFile(join(projectRoot, ".mastracode", "workflow", "long.ts"), cancellableWorkflowFixture());
    const sandbox = localSandboxMachine(projectRoot);
    if (!sandbox.executeCommand) throw new Error("LocalSandbox command execution is unavailable");
    const workspace = new Workspace({
      id: "factory-project-workflow-cancellation-test",
      filesystem: new SandboxFilesystem({
        sandbox: {
          id: sandbox.id,
          executeCommand: (command, args, options) => sandbox.executeCommand!(command, args, options),
        },
        workdir: projectRoot,
      }),
      sandbox,
    });
    await workspace.init();
    const tools = await factoryIntegration().agentTools();
    const projectWorkflow = tools.project_workflow as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    const cancellation = new AbortController();

    try {
      const execution = projectWorkflow.execute?.({
        action: "run",
        workflowId: "long",
        input: {},
      }, {
        requestContext: new RequestContext(),
        workspace,
        abortSignal: cancellation.signal,
      });
      await waitForFile(join(projectRoot, "workflow-started.txt"));
      cancellation.abort();

      await expect(execution).rejects.toThrow(/cancelled/i);
      await expect(readFile(join(projectRoot, "workflow-cancelled.txt"), "utf8")).resolves.toBe("cancelled");
      await expect(readdir(join(projectRoot, ".mastracode", ".factory-runtime"))).resolves.toEqual([]);
    } finally {
      await workspace.destroy();
    }
  }, 30_000);

  test("refuses to execute project workflows against a host filesystem", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "rlabs-factory-workflow-host-"));
    const sandbox = localSandboxMachine(projectRoot);
    const workspace = new Workspace({
      id: "factory-project-workflow-host-test",
      filesystem: new LocalFilesystem({ basePath: projectRoot }),
      sandbox,
    });
    await workspace.init();
    const tools = await factoryIntegration().agentTools();
    const projectWorkflow = tools.project_workflow as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    try {
      await expect(projectWorkflow.execute?.({ action: "list" }, {
        requestContext: new RequestContext(),
        workspace,
      })).rejects.toThrow(/sandbox-backed Factory session workspace/i);
    } finally {
      await workspace.destroy();
    }
  });

  test("reports an actionable runtime-layer error when the sandbox lacks the workflow runner", async () => {
    const tools = await factoryIntegration().agentTools();
    const projectWorkflow = tools.project_workflow as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    await expect(projectWorkflow.execute?.({ action: "list" }, {
      requestContext: new RequestContext(),
      workspace: {
        resolveFilesystem: async () => ({ provider: "sandbox", basePath: "/workspace/project" }),
        resolveSandbox: async () => ({
          executeCommand: async () => ({
            exitCode: 127,
            stdout: "",
            stderr: "sh: tsx: command not found",
          }),
        }),
      },
    })).rejects.toThrow(/mcode-runtime.*tsx/i);
  });

  test("rejects duplicate workflow IDs like the canonical local loader", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "rlabs-factory-workflow-duplicate-"));
    await mkdir(join(projectRoot, ".mastracode", "workflow"), { recursive: true });
    await writeFile(join(projectRoot, ".mastracode", "workflow", "first.ts"), workflowFixture("duplicate", true));
    await writeFile(join(projectRoot, ".mastracode", "workflow", "second.ts"), workflowFixture("duplicate", true));
    const sandbox = new LocalSandbox({
      workingDirectory: projectRoot,
      isolation: "none",
      env: process.env,
    });
    if (!sandbox.executeCommand) throw new Error("LocalSandbox command execution is unavailable");
    const workspace = new Workspace({
      id: "factory-project-workflow-duplicate-test",
      filesystem: new SandboxFilesystem({
        sandbox: {
          id: sandbox.id,
          executeCommand: (command, args, options) => sandbox.executeCommand!(command, args, options),
        },
        workdir: projectRoot,
      }),
      sandbox,
    });
    await workspace.init();
    const tools = await factoryIntegration().agentTools();
    const projectWorkflow = tools.project_workflow as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    try {
      await expect(projectWorkflow.execute?.({ action: "list" }, {
        requestContext: new RequestContext(),
        workspace,
      })).rejects.toThrow(/duplicate project workflow ID/i);
    } finally {
      await workspace.destroy();
    }
  });

  test("normalizes provider abort failures and cleans up when the cancellation marker cannot be written", async () => {
    const tools = await factoryIntegration().agentTools();
    const projectWorkflow = tools.project_workflow as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    const deleted: string[] = [];
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(projectWorkflow.execute?.({
      action: "run",
      workflowId: "cancel-provider",
      input: {},
    }, {
      requestContext: new RequestContext(),
      abortSignal: cancellation.signal,
      workspace: {
        resolveFilesystem: async () => ({
          provider: "sandbox",
          basePath: "/workspace/project",
          writeFile: async () => { throw new Error("marker write failed"); },
          deleteFile: async (path: string) => { deleted.push(path); },
        }),
        resolveSandbox: async () => ({
          executeCommand: async (_command: string, _args: string[], options: { abortSignal: AbortSignal }) => {
            await new Promise<void>((_resolve, reject) => {
              if (options.abortSignal.aborted) reject(new Error("provider aborted command"));
              else options.abortSignal.addEventListener("abort", () => reject(new Error("provider aborted command")), { once: true });
            });
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
      },
    })).rejects.toThrow(/cancelled/i);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^\.mastracode\/\.factory-runtime\/cancel-/);
  });

  test("executes a committed Mastra workflow step through the sandbox runtime", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "rlabs-factory-workflow-real-"));
    await mkdir(join(projectRoot, ".mastracode", "workflow"), { recursive: true });
    await writeFile(join(projectRoot, ".mastracode", "workflow", "real.ts"), realWorkflowFixture());
    const sandbox = localSandboxMachine(projectRoot);
    if (!sandbox.executeCommand) throw new Error("LocalSandbox command execution is unavailable");
    const workspace = new Workspace({
      id: "factory-project-real-workflow-test",
      filesystem: new SandboxFilesystem({
        sandbox: {
          id: sandbox.id,
          executeCommand: (command, args, options) => sandbox.executeCommand!(command, args, options),
        },
        workdir: projectRoot,
      }),
      sandbox,
    });
    await workspace.init();
    const tools = await factoryIntegration().agentTools();
    const projectWorkflow = tools.project_workflow as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };

    try {
      await expect(projectWorkflow.execute?.({
        action: "run",
        workflowId: "real-workflow",
        input: { value: "real" },
      }, {
        requestContext: new RequestContext(),
        workspace,
      })).resolves.toMatchObject({
        status: "success",
        output: { value: "REAL" },
      });
      await expect(readFile(join(projectRoot, "real-workflow-step.txt"), "utf8")).resolves.toBe("real");
    } finally {
      await workspace.destroy();
    }
  }, 30_000);
});

function factoryIntegration(): ToolkitFactoryIntegration {
  const profile = loadModelProfile();
  return new ToolkitFactoryIntegration(createFactoryAgentBundle({
    profile,
    browser: false,
  }), resolveRuntimeDefaultsV1(profile));
}

function factorySessionRequestContext(): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set("user", { id: "user-1", organizationId: "org-1" });
  requestContext.set("controller", {
    threadId: "thread-1",
    resourceId: "session-1",
    getState: () => ({ factoryProjectId: "project-1" }),
  });
  return requestContext;
}

function workflowFixture(id: string, published: boolean): string {
  return `import { writeFile } from "node:fs/promises";

const schema = {
  "~standard": {
    version: 1,
    vendor: "fixture",
    validate: async (value: unknown) => (
      value && typeof value === "object" && typeof (value as { value?: unknown }).value === "string"
        ? { value: { ...value, value: (value as { value: string }).value.trim() } }
        : { issues: [{ message: "value is required" }] }
    ),
  },
};

${published ? `export const agentTool = { description: "Run ${id}", metadata: { fixture: true } };` : ""}

export default {
  component: "WORKFLOW",
  committed: true,
  id: "${id}",
  inputSchema: schema,
  outputSchema: schema,
  createRun: async () => ({
    runId: "${id}-run",
    cancel: async () => undefined,
    start: async ({ inputData, outputWriter, requestContext }: {
      inputData: { value?: string };
      outputWriter?: (chunk: unknown) => Promise<void>;
      requestContext?: unknown;
    }) => {
      await writeFile("workflow-ran.txt", "${id}:" + (inputData.value ?? ""));
      await outputWriter?.({ type: "fixture", value: inputData.value });
      ${id === "demo" ? `await new Promise(resolve => setTimeout(resolve, 250));
      await writeFile("workflow-finished.txt", "finished");` : ""}
      return {
        status: "success",
        result: {
          ...inputData,
          cwd: process.cwd(),
          privileged: process.env.FACTORY_PRIVILEGED_SENTINEL ?? null,
          requestContextPassed: requestContext !== undefined,
        },
      };
    },
  }),
};
`;
}

function cancellableWorkflowFixture(): string {
  return `import { writeFile } from "node:fs/promises";

const schema = {
  "~standard": {
    version: 1,
    vendor: "fixture",
    validate: async (value: unknown) => ({ value }),
  },
};

export const agentTool = { description: "Run until cancelled" };

let finish: ((result: { status: string }) => void) | undefined;

export default {
  component: "WORKFLOW",
  committed: true,
  id: "long",
  inputSchema: schema,
  outputSchema: schema,
  createRun: async () => ({
    runId: "long-run",
    cancel: async () => {
      await writeFile("workflow-cancelled.txt", "cancelled");
      finish?.({ status: "suspended" });
    },
    start: async () => {
      await writeFile("workflow-started.txt", "started");
      return new Promise(resolve => { finish = resolve; });
    },
  }),
};
`;
}

function realWorkflowFixture(): string {
  return `import { writeFile } from "node:fs/promises";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

const schema = z.object({ value: z.string() });
const step = createStep({
  id: "real-step",
  inputSchema: schema,
  outputSchema: schema,
  execute: async ({ inputData }: { inputData: { value: string } }) => {
    await writeFile("real-workflow-step.txt", inputData.value);
    return { value: inputData.value.toUpperCase() };
  },
});

export const agentTool = { description: "Run a real Mastra workflow" };
export default createWorkflow({
  id: "real-workflow",
  inputSchema: schema,
  outputSchema: schema,
}).then(step).commit();
`;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

function localSandboxMachine(root: string) {
  const config = loadSandboxConfig({
    SANDBOX_PROVIDER: "local",
    WORKSPACE_ROOT: root,
  }, process.cwd());
  return createSandboxMachine({
    provider: config.provider,
    workspaceRoot: config.workspaceRoot,
    specification: config.specification,
  });
}
