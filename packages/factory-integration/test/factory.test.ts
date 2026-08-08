import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiRoute } from "@mastra/core/server";
import { RequestContext } from "@mastra/core/request-context";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createToolkitAgents, ROLE_IDS } from "@rlabs/agents-roles";
import { createToolkitRuntimeContract } from "@rlabs/mastra-primitives-export";
import { loadModelProfile, resolveRuntimeDefaultsV1 } from "@rlabs/runtime-config";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFactoryControllerProjection,
  createFactoryRuntimeBinding,
  createProjectsManagedFactoryRules,
  createToolkitFactory,
  loadFactoryConfig,
  FACTORY_DYNAMIC_WORKFLOW_AGENT_IDS,
  type FactoryControllerProjection,
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
  test("makes GitHub Project Intake the only automatic GitHub admission path", async () => {
    const rules = createProjectsManagedFactoryRules();

    expect(rules.github.issueOpened?.onEvent).toBeTypeOf("function");
    expect(rules.github.pullRequestOpened?.onEvent).toBeTypeOf("function");
    expect(await rules.github.issueOpened?.onEvent?.({} as never)).toBeUndefined();
    expect(await rules.github.pullRequestOpened?.onEvent?.({} as never)).toBeUndefined();
    expect(rules.work.triage?.issue?.onEnter).toBeTypeOf("function");
    expect(rules.work.planning?.issue?.onEnter).toBeTypeOf("function");
  });

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
    // Derived, not literal: every canonical role is a first-class Factory
    // agent, so a role added to the canonical set registers here untouched.
    expect(Object.keys(projection.agents)).toEqual([...ROLE_IDS]);
    expect(projection).not.toHaveProperty("tools.command_run");
    expect(toolId(projection.tools.dynamic_workflow)).toBe("dynamic_workflow");
    for (const agent of Object.values(projection.agents)) {
      expect(Object.keys(await agent.listTools())).not.toContain("command_run");
    }
    // Canonical role policy decides which roles orchestrate; Factory only
    // decides that the capability exists and under which authority.
    expect(Object.keys(await projection.agents.cortex.listTools())).toContain("dynamic_workflow");
    expect(Object.keys(await projection.agents.zen.listTools())).toContain("dynamic_workflow");
    expect(Object.keys(await projection.agents.flux.listTools())).toContain("dynamic_workflow");
    expect(projection).not.toHaveProperty("controller");
  });

  test("contributes dynamic_workflow through the supported tool seam while delegation stays blocked", async () => {
    const profile = loadModelProfile();
    const bundle = createFactoryAgentBundle({ profile, browser: false });
    const tools = await new ToolkitFactoryIntegration(
      bundle,
      resolveRuntimeDefaultsV1(profile),
    ).agentTools();

    expect(tools).toHaveProperty("project_workflow");
    expect(toolId(tools.dynamic_workflow)).toBe("dynamic_workflow");
    // The upstream blocker gates controller ingredients, not this tool seam.
    expect(bundle.capability.controllerConstruction.canonicalModesAndSubagents).toBe("upstream-blocked");
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
      GITHUB_PROJECTS_TOKEN: "test-projects-token",
      GITHUB_PROJECTS_AUTOMATION_USER_ID: "local-user",
      GITHUB_PROJECTS_CONFIG: JSON.stringify({
        reconcileIntervalMs: 30_000,
        bindings: [{
          id: "agent-factory", orgId: "local-org", factoryProjectId: "factory-1",
          githubOrganization: "rlabs88", githubProjectNodeId: "PVT_1", githubProjectNumber: 5,
          statusFieldId: "status", statusOptions: {
            backlog: "backlog", intake: "intake", investigate: "investigate", planning: "planning",
            building: "building", review: "review", done: "done", canceled: "canceled",
          },
          executionFieldId: "execution",
          executionOptions: { automatic: "auto", manual: "manual", hitl: "hitl" },
          workTypeFieldId: "work-type",
          workTypeOptions: {
            implementation: "implementation", research: "research", prototype: "prototype",
            decision: "decision", map: "map",
          },
          enabled: true,
        }],
      }),
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
      // Diagnostics describe what is registered, so this list is derived and
      // must never be a literal that can drift from the canonical role set.
      agents: [...ROLE_IDS],
      runtimeDefaults: {
        source: "@rlabs/runtime-config/models.yaml",
        version: 1,
        factoryMemory: {
          observationThreshold: 180_000,
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
    expect(tools).not.toHaveProperty("delegate_cortex");
    expect(tools).not.toHaveProperty("delegate_flux");
    expect(tools).not.toHaveProperty("delegate_zen");
    expect(toolId(tools.dynamic_workflow)).toBe("dynamic_workflow");
    for (const agent of Object.values(bundle.agents)) {
      expect(Object.keys(await agent.listTools())).not.toContain("command_run");
    }
    const factory = await createToolkitFactory(config, bundle, defaults, environment);

    try {
      const prepared = await factory.prepare();
      // Every canonical role, not a literal three: Factory spreads the whole
      // projection agent map, so a new canonical role is registered here with
      // no change to this package.
      expect(prepared.agents).toMatchObject(
        Object.fromEntries(ROLE_IDS.map(id => [id, bundle.agents[id]])),
      );
      expect(Object.keys(prepared.agentControllers ?? {})).toEqual(["code"]);
      const workers = prepared.workers === false ? [] : (prepared.workers ?? []);
      expect(workers.map(worker => worker.name)).toContain("github-projects-v2-scheduler");
      const composed = new Mastra(prepared);
      for (const id of ROLE_IDS) {
        const registered = composed.getAgent(id);
        expect(registered.id).toBe(id);
        expect(Object.keys(await registered.listTools())).not.toContain("command_run");
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

describe("Factory dynamic workflow authority", () => {
  test("fails closed without an active Factory project session binding", async () => {
    const projection = factoryProjection();
    const mastra = orchestrationHost();
    const unbound = new RequestContext();

    // No Factory session address at all.
    await expect(runDynamicWorkflow(projection, mastra, dryRunGraph("cortex"), {
      requestContext: unbound,
    })).rejects.toThrow(/Factory project session/i);

    // A Factory session address, but no persisted session workspace.
    await expect(runDynamicWorkflow(projection, mastra, dryRunGraph("cortex"), {
      requestContext: factoryRequestContext("org-1", "project-1", "session-1"),
    })).rejects.toThrow(/Factory project session/i);

    // A workspace that is not the persisted, sandbox-backed Factory one.
    await expect(runDynamicWorkflow(projection, mastra, dryRunGraph("cortex"), {
      requestContext: factoryRequestContext("org-1", "project-1", "session-1"),
      workspace: {
        id: "scratch-workspace",
        resolveFilesystem: async () => undefined,
        resolveSandbox: async () => undefined,
      },
    })).rejects.toThrow(/Factory project session/i);

    // Rejection happens before any action dispatch, so inspect is gated too.
    await expect(runDynamicWorkflow(projection, mastra, { action: "inspect" }, {
      requestContext: unbound,
    })).rejects.toThrow(/Factory project session/i);
  });

  test("rejects resuming a run named by another Factory project before reading the store", async () => {
    const projection = factoryProjection();
    const mastra = orchestrationHost();
    const storage = vi.spyOn(mastra, "getStorage");

    const result = await runDynamicWorkflow(projection, mastra, {
      action: "resume",
      description: "resume a run owned by project-1",
      workflowId: "dyn_0123456789abcdef",
      runId: "run-owned-by-project-1",
      resumeData: {},
      timeoutMs: 1_000,
    }, factorySession("org-2", "project-2", "session-2"));

    expect(result.status).toBe("failed");
    // Factory pins resumable:false, so no cross-project definition or run row is read.
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  test("gives two Factory projects different ids for an identical graph", async () => {
    const projection = factoryProjection();
    const mastra = orchestrationHost();

    const first = await runDynamicWorkflow(
      projection, mastra, dryRunGraph("cortex"), factorySession("org-1", "project-1", "session-1"),
    );
    const second = await runDynamicWorkflow(
      projection, mastra, dryRunGraph("cortex"), factorySession("org-2", "project-2", "session-2"),
    );
    const again = await runDynamicWorkflow(
      projection, mastra, dryRunGraph("cortex"), factorySession("org-1", "project-1", "session-1"),
    );

    expect(first.status).toBe("validated");
    expect(second.status).toBe("validated");
    // The host-injected scope is mixed into the content address, so an
    // identical graph no longer collapses two projects onto one id, one
    // definition row, and one refcounted registration.
    expect(second.workflowId).not.toBe(first.workflowId);
    // Still content-addressed within one project session.
    expect(again.workflowId).toBe(first.workflowId);
  });

  test("never lists another Factory project's runs from inspect", async () => {
    const projection = factoryProjection();
    const mastra = orchestrationHost();
    const owner = factorySession("org-1", "project-1", "session-1");
    const other = factorySession("org-2", "project-2", "session-2");

    const ran = await runDynamicWorkflow(projection, mastra, modelFreeGraph(), owner);
    expect(ran.status, JSON.stringify(ran.issues ?? ran.error)).toBe("success");

    const seenByOwner = await runDynamicWorkflow(projection, mastra, { action: "inspect" }, owner);
    const seenByOther = await runDynamicWorkflow(projection, mastra, { action: "inspect" }, other);

    expect(inspectedWorkflowIds(seenByOwner)).toEqual([ran.workflowId]);
    expect(inspectedWorkflowIds(seenByOther)).toEqual([]);
  });

  test("bounds a Factory graph to the deliberately enumerated canonical agents", async () => {
    const projection = factoryProjection();
    const mastra = orchestrationHost();
    const session = factorySession("org-1", "project-1", "session-1");

    // A hand-maintained literal, deliberately not derived: this is a security
    // boundary, so a fifth canonical role must not join it by the canonical
    // list merely growing. Ayra is in it because the user widened it by hand.
    expect(FACTORY_DYNAMIC_WORKFLOW_AGENT_IDS).toEqual(["cortex", "flux", "zen", "ayra"]);

    for (const agentId of FACTORY_DYNAMIC_WORKFLOW_AGENT_IDS) {
      const allowed = await runDynamicWorkflow(projection, mastra, dryRunGraph(agentId), session);
      expect(allowed.status, `${agentId}: ${JSON.stringify(allowed.issues)}`).toBe("validated");
    }

    // Factory's own controller agent and per-project mounted specialists stay
    // out; admitting either is a separate deliberate decision.
    for (const agentId of ["code", "specialist"]) {
      const rejected = await runDynamicWorkflow(projection, mastra, dryRunGraph(agentId), session);
      expect(rejected.status, agentId).toBe("invalid");
      expect((rejected.issues as string[]).join(" ")).toContain(`unknown agent "${agentId}"`);
    }
  });
});

function factoryProjection(): FactoryControllerProjection {
  return createFactoryControllerProjection(
    createToolkitRuntimeContract({ profile: loadModelProfile() }),
    createFactoryRuntimeBinding(),
    { browser: false },
  );
}

/** A bare Mastra: the tool only needs the stored-workflow and storage surfaces. */
function orchestrationHost(): Mastra {
  return new Mastra({ storage: new InMemoryStore(), logger: false as never });
}

function factorySession(orgId: string, projectId: string, sessionId: string): {
  requestContext: RequestContext;
  workspace: unknown;
} {
  return {
    requestContext: factoryRequestContext(orgId, projectId, sessionId),
    workspace: {
      id: `mfw-${sessionId}`,
      resolveFilesystem: async () => ({ provider: "sandbox", basePath: `/workspaces/${sessionId}` }),
      resolveSandbox: async () => ({ executeCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }),
    },
  };
}

function dryRunGraph(agentId: string): Record<string, unknown> {
  return {
    action: "run",
    description: `dispatch ${agentId}`,
    dryRun: true,
    timeoutMs: 1_000,
    input: {},
    definition: {
      // `createStep(agent)` pins an agent step to `{ prompt }` -> `{ text }`.
      inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      graph: [{ type: "agent", id: "only", agentId }],
    },
  };
}

function runDynamicWorkflow(
  projection: FactoryControllerProjection,
  mastra: Mastra,
  input: unknown,
  context: { requestContext: RequestContext; workspace?: unknown },
): Promise<Record<string, unknown>> {
  return (projection.tools.dynamic_workflow as unknown as {
    execute(input: unknown, context: unknown): Promise<Record<string, unknown>>;
  }).execute(input, { mastra, ...context });
}

/** A real run needs no model: a sleep step is the identity on its input. */
function modelFreeGraph(): Record<string, unknown> {
  const schema = { type: "object", properties: { task: { type: "string" } }, required: ["task"] };
  return {
    action: "run",
    description: "pause briefly",
    dryRun: false,
    timeoutMs: 30_000,
    input: { task: "ship" },
    definition: { inputSchema: schema, outputSchema: schema, graph: [{ type: "sleep", id: "s", duration: 1 }] },
  };
}

function inspectedWorkflowIds(result: Record<string, unknown>): string[] {
  return (result.runs as Array<{ workflowId: string }>).map(run => run.workflowId);
}

function toolId(tool: unknown): string | undefined {
  return (tool as { id?: string } | undefined)?.id;
}

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
