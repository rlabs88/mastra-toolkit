import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiRoute } from "@mastra/core/server";
import { RequestContext } from "@mastra/core/request-context";
import { Mastra } from "@mastra/core/mastra";
import { createToolkitAgents } from "@rlabs/agents-roles";
import { createToolkitRuntimeContract } from "@rlabs/mastra-primitives-export";
import { loadModelProfile, resolveRuntimeDefaultsV1 } from "@rlabs/runtime-config";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import {
  createFactoryControllerProjection,
  createFactoryRuntimeBinding,
  createToolkitFactory,
  loadFactoryConfig,
} from "../src/index.js";
import {
  createFactoryAgentBundle,
  ToolkitFactoryIntegration,
} from "../src/index.js";

let dataDirectory: string | undefined;

afterEach(async () => {
  delete process.env.MASTRA_APP_DATA_DIR;
  delete process.env.FACTORY_HOST_TRAP;
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  dataDirectory = undefined;
});

describe("single-project Factory composition", () => {
  test("projects the shared contract without legacy command tools or a second controller", async () => {
    const profile = loadModelProfile();
    const contract = createToolkitRuntimeContract({ profile });
    const projection = createFactoryControllerProjection(
      contract,
      createFactoryRuntimeBinding(),
      { browser: false },
    );

    expect(projection.capability.contractDigest).toBe(contract.capability.digest);
    expect(projection.binding).toBeDefined();
    expect(projection.capability.projection).toBe("factory");
    expect(projection.capability.controllerConstruction).toEqual({
      owner: "@mastra/factory",
      count: 1,
      canonicalModesAndSubagents: "upstream-blocked",
      missingConstructionInputs: ["modes", "subagents", "controller-construction callback"],
    });
    expect(Object.keys(projection.agents)).toEqual(["cortex", "flux", "zen"]);
    expect(projection).not.toHaveProperty("tools.command_run");
    expect(projection).not.toHaveProperty("tools.dynamic_workflow");
    for (const agent of Object.values(projection.agents)) {
      expect(Object.keys(await agent.listTools())).not.toContain("command_run");
      expect(Object.keys(await agent.listTools())).not.toContain("adhd_run");
    }
    expect(projection).not.toHaveProperty("controller");
  });

  test("leaves canonical delegation unavailable when Factory cannot mount it safely", async () => {
    const profile = loadModelProfile();
    const bundle = createFactoryAgentBundle({ profile, browser: false });
    const tools = await new ToolkitFactoryIntegration(
      bundle,
      resolveRuntimeDefaultsV1(profile),
    ).agentTools();

    expect(tools).toHaveProperty("project_workflow");
    expect(tools).not.toHaveProperty("dynamic_workflow");
    expect(Object.keys(tools).filter(toolName =>
      toolName === "subagent" || /^(?:use|delegate)_(?:cortex|flux|zen)$/.test(toolName),
    )).toEqual([]);
  });

  test("resolves project, tenant, session, and workspace bindings per Factory request", async () => {
    const binding = createFactoryRuntimeBinding();
    if (!("resolve" in binding.identity)) throw new Error("Expected request-scoped Factory identity");
    const firstContext = factoryRequestContext("org-1", "project-1", "session-1");
    const secondContext = factoryRequestContext("org-2", "project-2", "session-2");
    const firstWorkspace = { id: "mfw-session-1" };
    const secondWorkspace = { id: "mfw-session-2" };

    expect(await binding.identity.resolve({ requestContext: firstContext })).toEqual({
      projectId: "project-1",
      userId: "org-1-user",
      sessionId: "session-1",
    });
    expect(await binding.identity.resolve({ requestContext: secondContext })).toEqual({
      projectId: "project-2",
      userId: "org-2-user",
      sessionId: "session-2",
    });
    expect(await binding.workspace.resolve({ workspace: firstWorkspace })).toBe(firstWorkspace);
    expect(await binding.workspace.resolve({ workspace: secondWorkspace })).toBe(secondWorkspace);

    const workosContext = factoryRequestContext("org-3", "project-3", "session-3");
    workosContext.set("user", { workosId: "workos-user-3", organizationId: "org-3" });
    expect(await binding.identity.resolve({ requestContext: workosContext })).toMatchObject({
      userId: "workos-user-3",
    });
  });

  test("rejects an unbranded agent bundle without the Factory session authorization boundary", () => {
    const profile = loadModelProfile();
    const bundle = {
      agents: createToolkitAgents({ profile, browser: false }),
    };

    expect(() => new ToolkitFactoryIntegration(
      bundle as never,
      resolveRuntimeDefaultsV1(profile),
    )).toThrow(/createFactoryControllerProjection/);
  });

  test("boots without a sandbox and fails GitHub project preparation closed", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "rlabs-factory-control-plane-"));
    const profile = loadModelProfile();
    const environment = {
      MASTRA_TOOLKIT_MODE: "factory",
      MASTRA_APP_DATA_DIR: dataDirectory,
      FACTORY_REPOSITORY_EXECUTION: "disabled",
      CLI_PROXY_API_KEY: "test-only-key",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "test-only-private-key",
      GITHUB_APP_CLIENT_ID: "test-client",
      GITHUB_APP_CLIENT_SECRET: "test-client-secret",
      GITHUB_APP_WEBHOOK_SECRET: "test-stable-state-secret",
      FACTORY_PUBLIC_URL: "http://127.0.0.1:4111",
      FACTORY_ALLOWED_ORIGINS: "http://127.0.0.1:4111",
    };
    const config = loadFactoryConfig(environment, process.cwd(), profile);
    const bundle = createFactoryAgentBundle({
      profile,
      browser: false,
    });
    const defaults = resolveRuntimeDefaultsV1(profile);
    expect(bundle).not.toHaveProperty("settings");
    const diagnostics = new ToolkitFactoryIntegration(bundle, defaults).diagnostics();
    expect(diagnostics).toMatchObject({
      runtimeDefaults: {
        source: "@rlabs/runtime-config/models.yaml",
        version: 1,
        factoryMemory: {
          observationThreshold: 120_000,
          reflectionThreshold: 60_000,
        },
        persistedPrecedence: "memory-settings-over-startup-defaults",
        fillPolicy: "null-fields-only",
        thresholdFillAtomicity: "unsupported-upstream",
        sessionDisplayConvergence: {
          status: "upstream-blocked",
          issue: "#129",
        },
      },
      agentBoundary: {
        source: "@rlabs/mastra-primitives-export",
        contractDigest: bundle.capability.contractDigest,
        controllerConstruction: bundle.capability.controllerConstruction,
        repositoryConfiguration: {
          verified: ["published-workflows"],
          upstreamUnverified: ["skills"],
          unsupported: ["instructions", "hooks", "commands", "plugins", "mcp", "specialists"],
        },
      },
    });
    const tools = await new ToolkitFactoryIntegration(bundle, defaults).agentTools();
    expect(tools).not.toHaveProperty("command_run");
    expect(tools).not.toHaveProperty("adhd_run");
    expect(tools).not.toHaveProperty("delegate_cortex");
    expect(tools).not.toHaveProperty("delegate_flux");
    expect(tools).not.toHaveProperty("delegate_zen");
    expect(tools).not.toHaveProperty("dynamic_workflow");
    for (const agent of Object.values(bundle.agents)) {
      expect(Object.keys(await agent.listTools())).not.toContain("command_run");
      expect(Object.keys(await agent.listTools())).not.toContain("adhd_run");
    }
    const factory = await createToolkitFactory(config, bundle, defaults, environment);

    try {
      const prepared = await factory.prepare();
      expect(prepared.agents).toMatchObject({
        cortex: bundle.agents.cortex,
        flux: bundle.agents.flux,
        zen: bundle.agents.zen,
      });
      expect(Object.keys(prepared.agentControllers ?? {})).toEqual(["code"]);
      const composed = new Mastra(prepared);
      for (const id of ["cortex", "flux", "zen"] as const) {
        const registered = composed.getAgent(id);
        expect(registered.id).toBe(id);
        expect(Object.keys(await registered.listTools())).not.toContain("command_run");
        expect(Object.keys(await registered.listTools())).not.toContain("adhd_run");
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
      const bundle = createFactoryAgentBundle({ profile, browser: false });
      factory = await createToolkitFactory(config, bundle, resolveRuntimeDefaultsV1(profile));
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

function factoryRequestContext(orgId: string, projectId: string, sessionId: string): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set("user", { id: `${orgId}-user`, organizationId: orgId });
  requestContext.set("controller", {
    threadId: `${sessionId}-thread`,
    resourceId: sessionId,
    getState: () => ({ factoryProjectId: projectId }),
  });
  return requestContext;
}
