import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, test } from "vitest";
import { CODE_MODE_IDS } from "../src/agents/modes/index.js";
import { loadToolkitConfig } from "../src/config.js";
import { mountLocalProjectRuntime } from "../src/runtime/project.js";
import type { ProjectMcpRuntime } from "../src/project/runtime.js";

describe("local project runtime", () => {
  test("mounts the six canonical modes on one caller-owned Mastra", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "mastra-local-project-"));
    const dataDirectory = await mkdtemp(join(tmpdir(), "mastra-local-data-"));
    const workflowRoot = join(projectRoot, ".mastracode", "workflow");
    await mkdir(workflowRoot, { recursive: true });
    await writeFile(join(workflowRoot, "smoke.ts"), workflowSource());
    const runtime = await mountLocalProjectRuntime({
      cwd: projectRoot,
      dataDirectory,
      config: loadToolkitConfig({
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
      expect(runtime.controller.getMastra()).toBe(runtime.mastra);
      expect(runtime.controller.listModes().map(mode => mode.id)).toEqual(CODE_MODE_IDS);
      expect(runtime.mastra.getAgent("cortex").id).toBe(runtime.agents.cortex.id);
      expect(runtime.mastra.getGateway("proxy").id).toBe("proxy");

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
          modeTools: (input: { requestContext: RequestContext }) => Promise<Record<string, unknown>> | Record<string, unknown>;
        }>;
        resolveCurrentModeInstructions(session: typeof first): string | undefined;
      };
      const context = await controller.buildRequestContext(first, requestContext);
      const toolsets = await controller.buildToolsets(first, context);
      const modeTools = await toolsets.modeTools({ requestContext: context });
      expect(Object.keys(toolsets.controllerBuiltIn)).toContain("ask_user");
      expect(Object.keys(modeTools)).toContain("project_specialist");
      expect(Object.keys(modeTools)).toContain("workflow_runtime_smoke");
      expect(Object.keys(modeTools)).toContain("request_access");

      for (const agentId of ["cortex", "flux", "zen"] as const) {
        await first.mode.switch({ modeId: `${agentId}/scope` });
        const scopeAgent = runtime.controller.getCurrentAgent(first);
        const scopeTools = await resolveModeTools(controller, first);
        expect(scopeAgent).toBe(runtime.agents[agentId]);
        expect(await scopeAgent.getInstructions({ requestContext: context })).toContain("# Base Identity");
        expect(controller.resolveCurrentModeInstructions(first)).toContain("# Scope mode");

        await first.mode.switch({ modeId: `${agentId}/build` });
        const buildTools = await resolveModeTools(controller, first);
        expect(runtime.controller.getCurrentAgent(first)).toBe(runtime.agents[agentId]);
        expect(controller.resolveCurrentModeInstructions(first)).toContain("# Build mode");
        expect(Object.keys(buildTools).sort()).toEqual(Object.keys(scopeTools).sort());
      }
    } finally {
      await runtime.close();
    }
  }, 30_000);
});

function fakeMcpRuntime(): ProjectMcpRuntime {
  return {
    async reload() {},
    getTools: () => ({}),
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

async function resolveModeTools(
  controller: {
    buildRequestContext(session: any, context: RequestContext): Promise<RequestContext>;
    buildToolsets(session: any, context: RequestContext): Promise<{
      modeTools: (input: { requestContext: RequestContext }) => Promise<Record<string, unknown>> | Record<string, unknown>;
    }>;
  },
  session: any,
): Promise<Record<string, unknown>> {
  const context = await controller.buildRequestContext(session, new RequestContext());
  const toolsets = await controller.buildToolsets(session, context);
  return toolsets.modeTools({ requestContext: context });
}
