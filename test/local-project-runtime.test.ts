import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { createWorkspaceTools, LocalFilesystem, Workspace } from "@mastra/core/workspace";
import { describe, expect, test, vi } from "vitest";
import { CODE_MODE_IDS, loadMcodeConfig, mountMcodeRuntime } from "@rlabs/mcode";
import type { McpLifecyclePort, PreparedMcpGeneration } from "@rlabs/project-mounting-manager";

describe("local project runtime", () => {
  test("mounts the six canonical modes on one caller-owned Mastra", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mastra-local-project-"));
    const dataDirectory = await mkdtemp(join(tmpdir(), "mastra-local-data-"));
    const workflowRoot = join(projectRoot, ".mastracode", "workflow");
    await mkdir(workflowRoot, { recursive: true });
    await mkdir(join(projectRoot, ".github", "agents"), { recursive: true });
    await writeFile(join(workflowRoot, "smoke.ts"), workflowSource());
    await writeFile(
      join(projectRoot, ".github", "agents", "review.md"),
      "---\ndescription: Review the checkout\ntools: []\n---\n\nReview the checkout.",
    );
    const runtime = await mountMcodeRuntime({
      cwd: projectRoot,
      dataDirectory,
      config: loadMcodeConfig({
        WORKSPACE_ROOT: projectRoot,
        SANDBOX_PROVIDER: "local",
        CLI_PROXY_API_KEY: "test-only-key",
      }),
      browser: false,
      watch: false,
      mcp: fakeMcpRuntime(),
    });

    try {
      expect(runtime.project.rootPath).toBe(projectRoot);
      expect(runtime.projection.capability.contractDigest).toBe(runtime.contract.capability.digest);
      expect(runtime.projection.capability.projection).toBe("mcode");
      expect(runtime.controller.getMastra()).toBe(runtime.mastra);
      expect(runtime.controller.listModes().map(mode => mode.id)).toEqual(CODE_MODE_IDS);
      expect(runtime.mastra.getAgent("cortex").id).toBe(runtime.agents.cortex.id);
      expect(runtime.mastra.getGateway("proxy").id).toBe("proxy");
      const controllerConfig = (runtime.controller as unknown as {
        config: { subagents?: Array<{ id: string; defaultModelId?: string; tools?: Record<string, unknown> }> };
      }).config;
      expect(controllerConfig.subagents?.map(subagent => ({
        id: subagent.id,
        defaultModelId: subagent.defaultModelId,
        tools: Object.keys(subagent.tools ?? {}),
      }))).toEqual([
        { id: "cortex", defaultModelId: "proxy/a1-proxy/code-frontier-high", tools: [] },
        { id: "flux", defaultModelId: "proxy/a1-proxy/code-frontier-high", tools: [] },
        { id: "zen", defaultModelId: "proxy/a1-proxy/code-frontier-high", tools: [] },
      ]);

      const first = await runtime.controller.createSession({ id: "first", ownerId: "test", scope: "first" });
      const second = await runtime.controller.createSession({ id: "second", ownerId: "test", scope: "second" });
      expect(first.mode.get()).toBe("cortex/build");
      expect(runtime.controller.getCurrentAgent(first)).toBe(runtime.agents.cortex);
      await first.mode.switch({ modeId: "flux/scope" });
      expect(runtime.controller.getCurrentAgent(first)).toBe(runtime.agents.flux);
      expect(second.mode.get()).toBe("cortex/build");

      const requestContext = new RequestContext();
      const controller = runtime.controller as unknown as {
        buildRequestContext(session: typeof first, context: RequestContext): Promise<RequestContext>;
        buildToolsets(session: typeof first, context: RequestContext): Promise<{
          controllerBuiltIn: Record<string, unknown>;
        }>;
        resolveCurrentModeInstructions(session: typeof first): string | undefined;
      };
      const context = await controller.buildRequestContext(first, requestContext);
      const toolsets = await controller.buildToolsets(first, context);
      expect(Object.keys(toolsets.controllerBuiltIn)).toContain("ask_user");
      const subagentTool = toolsets.controllerBuiltIn.subagent as {
        description: string;
        inputSchema: { parse(input: unknown): { agentType: string } };
      };
      expect(subagentTool.description).toContain("**cortex**");
      expect(subagentTool.description).toContain("**flux**");
      expect(subagentTool.description).toContain("**zen**");
      for (const agentType of ["cortex", "flux", "zen"]) {
        expect(subagentTool.inputSchema.parse({ agentType, task: "Inspect the runtime" }).agentType).toBe(agentType);
      }
      expect(() => subagentTool.inputSchema.parse({ agentType: "unknown", task: "Inspect" })).toThrow();
      const activeWorkspace = await runtime.controller.getCurrentAgent(first).getWorkspace({ requestContext: context });
      if (!activeWorkspace) throw new Error("Expected the active project workspace");

      const isolatedRoot = await mkdtemp(join(tmpdir(), "mastra-isolated-subagent-"));
      const isolatedWorkspace = new Workspace({
        id: "isolated-subagent-workspace",
        filesystem: new LocalFilesystem({ basePath: isolatedRoot, contained: true }),
      });
      const observedRuns: Array<{ id: string; workspaceId: string; toolIds: string[] }> = [];
      const stream = vi.spyOn(Agent.prototype, "stream").mockImplementation((async function (
        this: Agent,
        ...args: unknown[]
      ) {
        const messages = args[0];
        const options = args[1] as { requestContext?: RequestContext; abortSignal?: AbortSignal } | undefined;
        const requestContext = options?.requestContext as RequestContext;
        const workspace = await this.getWorkspace({ requestContext });
        if (!workspace) throw new Error("Expected the delegated workspace");
        const toolIds = Object.keys(await this.listTools({ requestContext }));
        observedRuns.push({ id: this.id, workspaceId: workspace.id, toolIds });
        const abortSignal = options?.abortSignal;
        if (String(messages).includes("wait for cancellation")) {
          return {
            fullStream: (async function*() {
              await new Promise<void>(resolve => {
                if (abortSignal?.aborted) resolve();
                else abortSignal?.addEventListener("abort", () => resolve(), { once: true });
              });
            })(),
            getFullOutput: async () => ({ text: "should-not-complete" }),
          } as never;
        }
        return {
          fullStream: (async function*() {})(),
          getFullOutput: async () => ({ text: `${this.id}:ok` }),
        } as never;
      }) as never);
      const executeSubagent = (subagentTool as unknown as {
        execute?: (input: unknown, context: unknown) => Promise<{ content: string; isError: boolean }>;
      }).execute;
      if (!executeSubagent) throw new Error("Expected the native AgentController subagent executor");

      try {
        for (const [agentType, workspace] of [
          ["cortex", activeWorkspace],
          ["flux", isolatedWorkspace],
          ["zen", activeWorkspace],
        ] as const) {
          const result = await executeSubagent(
            { agentType, task: `Run ${agentType}` },
            { requestContext: context, workspace, agent: { toolCallId: `${agentType}-call` } },
          );
          expect(result).toEqual({ content: `subagent-${agentType}:ok`, isError: false });
        }

        const abortController = new AbortController();
        const controllerState = context.get("controller") as Record<string, unknown>;
        const cancellationContext = new RequestContext(context.entries());
        cancellationContext.set("controller", { ...controllerState, abortSignal: abortController.signal });
        const cancelled = executeSubagent(
          { agentType: "cortex", task: "wait for cancellation" },
          { requestContext: cancellationContext, workspace: activeWorkspace, agent: { toolCallId: "cancel-call" } },
        );
        await Promise.resolve();
        abortController.abort();
        await expect(cancelled).resolves.toEqual({ content: "[Aborted by user]", isError: false });
      } finally {
        stream.mockRestore();
      }

      expect(observedRuns.map(({ id, workspaceId }) => ({ id, workspaceId }))).toEqual([
        { id: "subagent-cortex", workspaceId: activeWorkspace.id },
        { id: "subagent-flux", workspaceId: isolatedWorkspace.id },
        { id: "subagent-zen", workspaceId: activeWorkspace.id },
        { id: "subagent-cortex", workspaceId: activeWorkspace.id },
      ]);
      for (const run of observedRuns) {
        expect(run.toolIds).not.toContain("subagent");
        expect(run.toolIds).not.toContain("command_run");
        expect(run.toolIds).not.toContain("adhd_run");
      }

      const agentTools = await runtime.controller.getCurrentAgent(first).listTools({ requestContext: context });
      expect(Object.keys(agentTools)).toContain("project_specialist");
      expect(Object.keys(agentTools)).not.toContain("command_run");
      expect(Object.keys(agentTools)).not.toContain("adhd_run");
      expect(Object.keys(agentTools)).toContain("workflow_runtime_smoke");
      expect(Object.keys(agentTools)).toContain("request_access");
      const nativeTools = await createWorkspaceTools(activeWorkspace, { requestContext: context, workspace: activeWorkspace });
      expect(Object.keys(nativeTools)).toEqual(expect.arrayContaining(["view", "find_files", "write_file", "execute_command"]));
      expect(Object.keys(nativeTools)).not.toContain("command_run");
      expect(Object.keys(nativeTools)).not.toContain("adhd_run");
      const executeResult = await nativeTools.execute_command.execute(
        { command: "pwd" },
        { requestContext: context, workspace: activeWorkspace },
      );
      expect(JSON.stringify(executeResult)).toContain(projectRoot);

      const specialist = runtime.resources.snapshot().specialistAgents.get("review")!;
      const specialistTools = await specialist.listTools({ requestContext: context });
      expect(Object.keys(specialistTools)).not.toContain("command_run");
      expect(Object.keys(specialistTools)).not.toContain("adhd_run");
      expect(await specialist.getWorkspace({ requestContext: context })).toBe(activeWorkspace);

      for (const agentId of ["cortex", "flux", "zen"] as const) {
        await first.mode.switch({ modeId: `${agentId}/scope` });
        const scopeAgent = runtime.controller.getCurrentAgent(first);
        const scopeTools = await resolveAgentTools(controller, first, scopeAgent);
        expect(scopeAgent).toBe(runtime.agents[agentId]);
        expect(Object.keys(scopeTools)).toContain("workflow_runtime_smoke");
        expect((await controller.buildToolsets(first, context)).controllerBuiltIn).toHaveProperty("subagent");
        expect(await scopeAgent.getInstructions({ requestContext: context })).toContain("# Base Identity");
        expect(controller.resolveCurrentModeInstructions(first)).toContain("# Scope mode");

        await first.mode.switch({ modeId: `${agentId}/build` });
        const buildTools = await resolveAgentTools(controller, first, runtime.controller.getCurrentAgent(first));
        expect(runtime.controller.getCurrentAgent(first)).toBe(runtime.agents[agentId]);
        expect((await controller.buildToolsets(first, context)).controllerBuiltIn).toHaveProperty("subagent");
        expect(controller.resolveCurrentModeInstructions(first)).toContain("# Build mode");
        expect(Object.keys(buildTools).sort()).toEqual(Object.keys(scopeTools).sort());
      }
    } finally {
      await runtime.close();
    }
  }, 30_000);
});

function fakeMcpRuntime(): McpLifecyclePort {
  return {
    async prepare(): Promise<PreparedMcpGeneration> {
      return { snapshot: () => ({}), async commit() {}, async rollback() {} };
    },
    async close() {},
  };
}

function workflowSource(): string {
  return `import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
const schema = z.object({ message: z.string() });
const step = createStep({ id: "echo", inputSchema: schema, outputSchema: schema, execute: async ({ inputData }) => inputData });
export default createWorkflow({ id: "runtime_smoke", inputSchema: schema, outputSchema: schema }).then(step).commit();
export const agentTool = { description: "Run smoke" };
`;
}

async function resolveAgentTools(
  controller: {
    buildRequestContext(session: any, context: RequestContext): Promise<RequestContext>;
  },
  session: any,
  agent: { listTools(input: { requestContext: RequestContext }): Promise<Record<string, unknown>> },
): Promise<Record<string, unknown>> {
  const context = await controller.buildRequestContext(session, new RequestContext());
  return agent.listTools({ requestContext: context });
}
