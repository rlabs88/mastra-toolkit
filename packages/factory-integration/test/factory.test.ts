import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiRoute } from "@mastra/core/server";
import { RequestContext } from "@mastra/core/request-context";
import { createMcodeRecipe } from "@rlabs/mcode/recipe";
import { loadModelProfile } from "@rlabs/runtime-config";
import { createSandboxCommandRunTool } from "@rlabs/sandbox";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import { loadFactoryConfig } from "../src/config.js";
import { createToolkitFactory } from "../src/create.js";
import { ToolkitFactoryIntegration } from "../src/toolkit-integration.js";

let dataDirectory: string | undefined;

afterEach(async () => {
  delete process.env.MASTRA_APP_DATA_DIR;
  delete process.env.FACTORY_HOST_TRAP;
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  dataDirectory = undefined;
});

describe("single-project Factory composition", () => {
  test("boots without a sandbox and fails GitHub project preparation closed", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "rlabs-factory-control-plane-"));
    process.env.MASTRA_APP_DATA_DIR = dataDirectory;
    const config = loadFactoryConfig({
      MASTRA_TOOLKIT_MODE: "factory",
      FACTORY_REPOSITORY_EXECUTION: "disabled",
      CLI_PROXY_API_KEY: "test-only-key",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "test-only-private-key",
      GITHUB_APP_CLIENT_ID: "test-client",
      GITHUB_APP_CLIENT_SECRET: "test-client-secret",
      GITHUB_APP_WEBHOOK_SECRET: "test-stable-state-secret",
    }, process.cwd());
    const recipe = createMcodeRecipe({
      profile: loadModelProfile(),
      commandRun: createSandboxCommandRunTool(),
      browser: false,
    });
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
    expect(sandboxInvoked).toBe(false);
    const factory = await createToolkitFactory(config, recipe);

    try {
      const prepared = await factory.prepare();
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
      const recipe = createMcodeRecipe({ profile, commandRun: createSandboxCommandRunTool(), browser: false });
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
});
