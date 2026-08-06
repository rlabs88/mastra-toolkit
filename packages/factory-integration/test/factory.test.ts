import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiRoute } from "@mastra/core/server";
import { RequestContext } from "@mastra/core/request-context";
import { Mastra } from "@mastra/core/mastra";
import { createMcodeRecipe } from "@rlabs/mcode/recipe";
import { loadModelProfile } from "@rlabs/runtime-config";
import { createSandboxCommandRunTool } from "@rlabs/sandbox";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadFactoryConfig } from "../src/config.js";
import { createToolkitFactory } from "../src/create.js";
import {
  createFactoryMcodeRecipe,
  ToolkitFactoryIntegration,
} from "../src/toolkit-integration.js";

let dataDirectory: string | undefined;

afterEach(async () => {
  delete process.env.MASTRA_APP_DATA_DIR;
  delete process.env.FACTORY_HOST_TRAP;
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  dataDirectory = undefined;
});

describe("single-project Factory composition", () => {
  test("rejects an MCode recipe without the Factory session authorization boundary", () => {
    const profile = loadModelProfile();
    const recipe = createMcodeRecipe({ profile, commandRun: createSandboxCommandRunTool(), browser: false });

    expect(() => new ToolkitFactoryIntegration(recipe as never)).toThrow(/createFactoryMcodeRecipe/);
  });

  test("boots without a sandbox and fails GitHub project preparation closed", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "rlabs-factory-control-plane-"));
    process.env.MASTRA_APP_DATA_DIR = dataDirectory;
    const profile = loadModelProfile();
    const config = loadFactoryConfig({
      MASTRA_TOOLKIT_MODE: "factory",
      FACTORY_REPOSITORY_EXECUTION: "disabled",
      CLI_PROXY_API_KEY: "test-only-key",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "test-only-private-key",
      GITHUB_APP_CLIENT_ID: "test-client",
      GITHUB_APP_CLIENT_SECRET: "test-client-secret",
      GITHUB_APP_WEBHOOK_SECRET: "test-stable-state-secret",
      FACTORY_PUBLIC_URL: "http://127.0.0.1:4111",
      FACTORY_ALLOWED_ORIGINS: "http://127.0.0.1:4111",
    }, process.cwd(), profile);
    const recipe = createFactoryMcodeRecipe({
      profile,
      browser: false,
    });
    expect(recipe.settings.profile).toBe(profile);
    expect(recipe.settings.profile.aliases).toEqual(loadModelProfile().aliases);
    const diagnostics = new ToolkitFactoryIntegration(recipe).diagnostics();
    expect(diagnostics).toMatchObject({
      mcode: {
        digest: recipe.capability.digest,
        controllerConstruction: "unsupported-upstream",
        repositoryConfiguration: {
          verified: ["published-workflows"],
          upstreamUnverified: ["skills"],
          unsupported: ["instructions", "hooks", "commands", "plugins", "mcp", "specialists"],
        },
      },
    });
    await expect(new ToolkitFactoryIntegration(recipe).agentTools()).resolves.toHaveProperty("command_run");
    const tools = await new ToolkitFactoryIntegration(recipe).agentTools();
    const commandRun = tools.command_run as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    const delegateCortex = tools.delegate_cortex as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    let sandboxInvoked = false;
    const unboundContext = {
      requestContext: new RequestContext(),
      workspace: {
        id: "control-plane-fallback",
        resolveFilesystem: async () => ({ provider: "local", basePath: dataDirectory }),
        resolveSandbox: async () => ({
          executeCommand: async () => {
            sandboxInvoked = true;
            return { exitCode: 0, stdout: dataDirectory, stderr: "" };
          },
        }),
      },
    };
    await expect(commandRun.execute?.({
      description: "must not execute on the Factory host",
      commands: [{ command_type: "shell", command_line: "pwd", step: 1 }],
    }, unboundContext)).rejects.toThrow(/persisted Factory project session/i);
    await expect(delegateCortex.execute?.({ task: "must not delegate on the Factory host", maxSteps: 1 }, unboundContext))
      .rejects.toThrow(/persisted Factory project session/i);
    for (const agent of Object.values(recipe.agents)) {
      const directCommandRun = (await agent.listTools()).command_run as {
        execute?: (input: unknown, context: unknown) => Promise<unknown>;
      };
      await expect(directCommandRun.execute?.({
        description: "must not execute through a directly addressed Factory agent",
        commands: [{ command_type: "shell", command_line: "pwd", step: 1 }],
      }, unboundContext)).rejects.toThrow(/persisted Factory project session/i);
    }
    expect(sandboxInvoked).toBe(false);
    const factory = await createToolkitFactory(config, recipe);

    try {
      const prepared = await factory.prepare();
      expect(prepared.agents).toMatchObject({
        cortex: recipe.agents.cortex,
        flux: recipe.agents.flux,
        zen: recipe.agents.zen,
      });
      const composed = new Mastra(prepared);
      for (const id of ["cortex", "flux", "zen"] as const) {
        const registered = composed.getAgent(id);
        expect(registered.id).toBe(id);
        expect(await registered.listTools()).toHaveProperty("command_run");
      }
      expect(composed.getAgentController("code")).toBeDefined();
      expect(prepared.server?.host).toBe("127.0.0.1");
      await expect(access(join(dataDirectory, "factory.db"))).resolves.toBeUndefined();
      const route = (prepared.server?.apiRoutes ?? []).find(
        (candidate): candidate is Extract<ApiRoute, { handler: unknown }> =>
          candidate.path === "/web/github/projects/:id/ensure" && "handler" in candidate,
      );
      expect(route).toBeDefined();

      const app = new Hono();
      app.on("POST", route!.path, route!.handler);
      const response = await app.request("/web/github/projects/project/ensure", {
        method: "POST",
        headers: { authorization: "Bearer local" },
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "sandbox_not_configured",
        message: "No sandbox provider is configured.",
      });
    } finally {
      await factory.shutdown();
    }
  }, 30_000);

  test("does not load executable configuration from the Factory process checkout", async () => {
    const originalDirectory = process.cwd();
    const hostTrapDirectory = await mkdtemp(join(tmpdir(), "rlabs-factory-host-trap-"));
    dataDirectory = await mkdtemp(join(tmpdir(), "rlabs-factory-safe-data-"));
    await writeFile(join(hostTrapDirectory, ".env"), "FACTORY_HOST_TRAP=loaded\n");
    process.env.MASTRA_APP_DATA_DIR = dataDirectory;
    delete process.env.FACTORY_HOST_TRAP;
    process.chdir(hostTrapDirectory);
    const canonicalHostTrapDirectory = process.cwd();
    let factory: Awaited<ReturnType<typeof createToolkitFactory>> | undefined;

    try {
      const profile = loadModelProfile();
      const config = loadFactoryConfig({
        MASTRA_TOOLKIT_MODE: "factory",
        FACTORY_REPOSITORY_EXECUTION: "disabled",
        CLI_PROXY_API_KEY: "test-only-key",
      }, hostTrapDirectory, profile);
      const recipe = createFactoryMcodeRecipe({ profile, browser: false });
      factory = await createToolkitFactory(config, recipe);
      await factory.prepare();
      expect(process.env.FACTORY_HOST_TRAP).toBeUndefined();
      expect(process.cwd()).toBe(canonicalHostTrapDirectory);
    } finally {
      await factory?.shutdown();
      process.chdir(originalDirectory);
      await rm(hostTrapDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  test("returns delegated command results when a canonical agent ends on a tool step", async () => {
    const profile = loadModelProfile();
    const recipe = createFactoryMcodeRecipe({ profile, browser: false });
    const commandResult = {
      version: 1,
      description: "show the bound checkout",
      results: [{ status: "completed", output: "/sandbox/project\n/sandbox/project\n" }],
      attachments: [],
    };
    const oversizedResult = { output: "x".repeat(5_000) };
    const generate = vi.spyOn(recipe.agents.cortex, "generate").mockResolvedValue({
      text: "",
      runId: "delegated-run-1",
      steps: [{
        toolResults: [{
          type: "tool-result",
          payload: {
            toolCallId: "command-call-1",
            toolName: "command_run",
            result: commandResult,
          },
        }, {
          type: "tool-result",
          payload: {
            toolCallId: "command-call-2",
            toolName: "command_run",
            result: oversizedResult,
          },
        }],
      }],
    } as never);
    const delegate = (await new ToolkitFactoryIntegration(recipe).agentTools()).delegate_cortex as {
      execute?: (input: unknown, context: unknown) => Promise<unknown>;
    };
    const requestContext = new RequestContext();
    const abortController = new AbortController();
    requestContext.set("user", { id: "user-1", organizationId: "org-1" });
    requestContext.set("controller", {
      threadId: "thread-1",
      resourceId: "session-1",
      getState: () => ({ factoryProjectId: "project-1" }),
    });

    const result = await delegate.execute?.({ task: "show the bound checkout", maxSteps: 4 }, {
      requestContext,
      abortSignal: abortController.signal,
      workspace: {
        id: "mfw-session-1",
        resolveFilesystem: async () => ({ provider: "sandbox", basePath: "/sandbox/project" }),
        resolveSandbox: async () => ({ executeCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }),
      },
    });

    expect(result).toEqual({
      agentId: "cortex",
      text: "",
      runId: "delegated-run-1",
      toolResults: [{
        toolCallId: "command-call-1",
        toolName: "command_run",
        output: JSON.stringify(commandResult),
        truncated: false,
      }, {
        toolCallId: "command-call-2",
        toolName: "command_run",
        output: JSON.stringify(oversizedResult).slice(0, 4_000),
        truncated: true,
      }],
    });
    expect(generate).toHaveBeenCalledWith("show the bound checkout", expect.objectContaining({
      abortSignal: abortController.signal,
      maxSteps: 4,
    }));
  });
});
