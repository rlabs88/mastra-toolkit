import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import { describe, expect, test, vi } from "vitest";
import {
  AYRA_ROLE,
  CORTEX_ROLE,
  FLUX_ROLE,
  ROLE_IDS,
  ROLES,
  ZEN_ROLE,
  TOOLKIT_WORKSPACE_CONTEXT_KEY,
  composePrompt,
  createToolkitAgentRegistry,
  createToolkitAgents,
  type ToolkitAgentsOptions,
} from "../src/index.js";

/**
 * The real tool is host-constructed and depends on a live Mastra runtime, so
 * these tests assert assignment only: which agents receive the orchestration
 * surface, and which are denied it.
 */
const dynamicWorkflowStub = {
  id: "dynamic_workflow",
  description: "Stub stand-in for the host-constructed dynamic workflow tool.",
  execute: async () => ({}),
} as unknown as NonNullable<ToolkitAgentsOptions["dynamicWorkflow"]>;

describe("canonical agent roles", () => {
  test("exports the canonical Cortex, Flux, Zen, and Ayra role definitions", () => {
    expect(ROLE_IDS).toEqual(["cortex", "flux", "zen", "ayra"]);
    expect(ROLES).toEqual({
      cortex: CORTEX_ROLE,
      flux: FLUX_ROLE,
      zen: ZEN_ROLE,
      ayra: AYRA_ROLE,
    });
    expect(ROLES.cortex.name).toBe("Cortex");
    expect(ROLES.flux.name).toBe("Flux");
    expect(ROLES.zen.name).toBe("Zen");
    expect(ROLES.ayra.name).toBe("Ayra");
  });

  test("publishes one root facade over four cohesive source modules", async () => {
    const packageRoot = join(import.meta.dirname, "..");
    const sourceEntries = await readdir(join(packageRoot, "src"), { withFileTypes: true });
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };

    expect(sourceEntries.map(entry => entry.name).sort()).toEqual([
      "agents.ts",
      "index.ts",
      "prompts.ts",
      "roles.ts",
    ]);
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
  });

  test.each(ROLE_IDS)("%s preserves the six prompt sections", id => {
    const headings = composePrompt(ROLES[id]).match(/^# .+$/gm);

    expect(headings).toEqual([
      "# Base Identity",
      "# Role Identity",
      "# Shared Security",
      "# Role Security Additions",
      "# Base Task Behavior",
      "# Role Task Behavior",
    ]);
  });

  test("keeps current role model policies", () => {
    expect(CORTEX_ROLE.model).toEqual({ id: "code-frontier-high", temperature: 0.2, steps: 80 });
    expect(FLUX_ROLE.model).toEqual({ id: "code-frontier-high", temperature: 0.7, steps: 80 });
    expect(ZEN_ROLE.model).toEqual({ id: "code-frontier-high", temperature: 0.1, steps: 48 });
    expect(AYRA_ROLE.model).toEqual({ id: "code-frontier-high", temperature: 0.3, steps: 80 });
  });

  test("describes Ayra as the agent provisioner and primary dynamic-workflow author", () => {
    const prompt = composePrompt(AYRA_ROLE);

    expect(AYRA_ROLE.id).toBe("ayra");
    expect(AYRA_ROLE.description).toMatch(/provision/i);
    expect(prompt).toMatch(/domain-focused agents/);
    expect(prompt).toMatch(/dynamic_workflow/);
    expect(prompt).toMatch(/graph-engineering/);
    expect(prompt).toMatch(/loop-engineering/);
  });

  test("teaches every role the difference between dynamic_workflow and subagent", () => {
    for (const id of ROLE_IDS) {
      const prompt = composePrompt(ROLES[id]);
      expect(prompt).toMatch(/dynamic_workflow/);
      expect(prompt).toMatch(/`subagent`/);
      expect(prompt).toMatch(/durable/i);
    }
  });

  test("preserves the exact current six-section prompts", () => {
    const hashes = Object.fromEntries(ROLE_IDS.map(id => [
      id,
      createHash("sha256").update(composePrompt(ROLES[id])).digest("hex"),
    ]));

    expect(hashes).toEqual({
      cortex: "08aab5280ec12e4c62c8d4989b4456cf084e01043a87e77951ff759f869b7751",
      flux: "200c0e2add58ede9ec0382800ab7c33ae529a0cec505328cb6982578030c0122",
      zen: "411351b9d27271fe546a4cdd879947d6e2b2ee717249cc3a1c3fd2341be81188",
    });
  });

  test("directs every role to native Mastra workspace tools", () => {
    for (const id of ROLE_IDS) {
      const prompt = composePrompt(ROLES[id]);
      expect(prompt).not.toMatch(/command_run|adhd_run/);
      expect(prompt).toMatch(/Mastra workspace/i);
    }
    const flux = composePrompt(FLUX_ROLE);
    expect(flux).toMatch(/Use the existing native subagent surface/i);
    expect(flux).toMatch(/Do not invent a replacement orchestration tool/i);
    expect(flux).not.toMatch(/ADHD|out-of-process|command-line tool|skill form/i);
  });

  test("creates the canonical non-recursive leaf set", async () => {
    const agents = createToolkitAgents({ browser: false });

    expect(Object.keys(agents)).toEqual(["cortex", "flux", "zen", "ayra"]);
    for (const agent of Object.values(agents)) expect(await agent.listAgents()).toEqual({});
  });

  test("creates canonical supervisors over non-recursive canonical leaves", async () => {
    const registry = createToolkitAgentRegistry({ browser: false });
    const workspace = new Workspace({
      id: "bound-workspace",
      filesystem: new LocalFilesystem({ basePath: process.cwd(), contained: true }),
    });
    const requestContext = new RequestContext<unknown>([[TOOLKIT_WORKSPACE_CONTEXT_KEY, workspace]]);

    for (const supervisor of Object.values(registry.supervisors)) {
      const targets = await supervisor.listAgents();
      expect(Object.keys(targets)).toEqual(["cortex", "flux", "zen", "ayra"]);
      expect(targets).toEqual(registry.leaves);
      expect(await supervisor.getWorkspace({ requestContext })).toBe(workspace);
    }
    for (const leaf of Object.values(registry.leaves)) {
      expect(await leaf.listAgents()).toEqual({});
      expect(await leaf.getWorkspace({ requestContext })).toBe(workspace);
    }
  });

  test("grants dynamic_workflow to every canonical supervisor", async () => {
    const registry = createToolkitAgentRegistry({
      browser: false,
      dynamicWorkflow: dynamicWorkflowStub,
    });

    expect(Object.keys(registry.supervisors)).toEqual([...ROLE_IDS]);
    for (const supervisor of Object.values(registry.supervisors)) {
      expect(Object.keys(await supervisor.listTools())).toContain("dynamic_workflow");
    }
  });

  test("withholds dynamic_workflow from every canonical leaf", async () => {
    const registry = createToolkitAgentRegistry({
      browser: false,
      dynamicWorkflow: dynamicWorkflowStub,
    });

    // A leaf is the bottom of the delegation tree. The tool's own depth guard
    // only trips on the request-context key its dispatch sets, which a
    // supervisor -> leaf hop never sets, so withholding the tool is the only
    // thing that keeps that path from re-entering graph authoring.
    expect(Object.keys(registry.leaves)).toEqual([...ROLE_IDS]);
    for (const leaf of Object.values(registry.leaves)) {
      expect(Object.keys(await leaf.listTools())).not.toContain("dynamic_workflow");
    }
  });

  test("keeps dynamic_workflow on the non-recursive agent set hosts mount directly", async () => {
    // MCode mounts this set as its top-level modes rather than as leaves, so the
    // orchestration surface stays with it.
    const agents = createToolkitAgents({ browser: false, dynamicWorkflow: dynamicWorkflowStub });

    for (const agent of Object.values(agents)) {
      expect(Object.keys(await agent.listTools())).toContain("dynamic_workflow");
    }
  });

  test("executes a canonical leaf through Mastra's native supervisor tool", async () => {
    const registry = createToolkitAgentRegistry({ browser: false });
    const workspace = new Workspace({
      id: "supervisor-workspace",
      filesystem: new LocalFilesystem({ basePath: process.cwd(), contained: true }),
    });
    const requestContext = new RequestContext<unknown>([[TOOLKIT_WORKSPACE_CONTEXT_KEY, workspace]]);
    const abortController = new AbortController();
    vi.spyOn(registry.leaves.flux, "getModel").mockResolvedValue({ specificationVersion: "v3" } as never);
    const generate = vi.spyOn(registry.leaves.flux, "generate").mockImplementation((async (...args: unknown[]) => {
      const options = args[1] as { requestContext?: RequestContext; abortSignal?: AbortSignal } | undefined;
      expect(options?.requestContext).toBe(requestContext);
      expect(options?.abortSignal).toBe(abortController.signal);
      expect(await registry.leaves.flux.getWorkspace({ requestContext })).toBe(workspace);
      return {
        text: "FLUX_SUPERVISOR_OK",
        response: { dbMessages: [] },
        toolResults: [],
        finishReason: "stop",
        usage: {},
      } as never;
    }) as never);
    const supervisor = registry.supervisors.cortex as unknown as {
      listAgentTools(options: Record<string, unknown>): Promise<Record<string, {
        execute?: (input: unknown, context: unknown) => Promise<unknown>;
      }>>;
    };
    const tools = await supervisor.listAgentTools({
      runId: "supervisor-run",
      threadId: "supervisor-thread",
      resourceId: "supervisor-resource",
      requestContext,
      methodType: "generate",
      autoResumeSuspendedTools: false,
      delegation: {},
      backgroundTaskEnabled: false,
    });

    expect(Object.keys(tools)).toEqual(["agent-cortex", "agent-flux", "agent-zen", "agent-ayra"]);
    const result = await tools["agent-flux"]?.execute?.(
      { prompt: "Inspect the canonical runtime" },
      { requestContext, abortSignal: abortController.signal },
    );

    expect(result).toMatchObject({ text: "FLUX_SUPERVISOR_OK" });
    expect(generate).toHaveBeenCalledOnce();
  });

  test("configures visible browser support for every canonical agent", () => {
    const agents = createToolkitAgents({ browser: true });

    expect(agents.cortex.browser).toBeDefined();
    expect(agents.flux.browser).toBeDefined();
    expect(agents.zen.browser).toBeDefined();
    expect(agents.ayra.browser).toBeDefined();
  });

  test("runs injected tool hooks without removing audit events", async () => {
    const beforeToolCall = vi.fn();
    const afterToolCall = vi.fn();
    const audit = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const agents = createToolkitAgents({
      browser: false,
      hooks: { beforeToolCall, afterToolCall },
    });
    const hooks = agents.cortex.getConfiguredToolHooks();

    await hooks?.beforeToolCall?.({ toolName: "subagent" } as never);
    await hooks?.afterToolCall?.({ toolName: "subagent" } as never);

    expect(beforeToolCall).toHaveBeenCalledOnce();
    expect(afterToolCall).toHaveBeenCalledOnce();
    expect(audit.mock.calls.map(([value]) => String(value))).toEqual([
      expect.stringContaining('"phase":"start"'),
      expect.stringContaining('"phase":"complete"'),
    ]);
    audit.mockRestore();
  });

  test("keeps Code mode and AgentController projections downstream", async () => {
    const sourceRoot = join(import.meta.dirname, "..", "src");
    const source = await Promise.all([
      "index.ts",
      "agents.ts",
      "prompts.ts",
      "roles.ts",
    ].map(path => readFile(join(sourceRoot, path), "utf8")));

    expect(source.join("\n")).not.toMatch(/agent-controller|createCodeModes|prepareAgentControllerMount/);
  });
});
