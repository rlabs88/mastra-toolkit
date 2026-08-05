import { mkdtemp } from "node:fs/promises";
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
      };
      const context = await controller.buildRequestContext(first, requestContext);
      const toolsets = await controller.buildToolsets(first, context);
      const modeTools = await toolsets.modeTools({ requestContext: context });
      expect(Object.keys(toolsets.controllerBuiltIn)).toContain("ask_user");
      expect(Object.keys(modeTools)).toContain("project_specialist");
      expect(Object.keys(modeTools)).toContain("request_access");
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
