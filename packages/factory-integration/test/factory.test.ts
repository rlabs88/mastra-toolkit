import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiRoute } from "@mastra/core/server";
import { createToolkitAgents } from "@rlabs/agents-roles";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import { loadFactoryConfig } from "../src/config.js";
import { createToolkitFactory } from "../src/create.js";

let dataDirectory: string | undefined;

afterEach(async () => {
  delete process.env.MASTRA_APP_DATA_DIR;
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
    const agents = createToolkitAgents({ workspaceRoot: process.cwd(), browser: false });
    const factory = await createToolkitFactory(config, agents);

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
});
