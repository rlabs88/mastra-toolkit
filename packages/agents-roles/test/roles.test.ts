import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, test, vi } from "vitest";
import {
  CORTEX_ROLE,
  FLUX_ROLE,
  ROLE_IDS,
  ROLES,
  ZEN_ROLE,
  TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY,
  composePrompt,
  createToolkitAgents,
} from "../src/index.js";

describe("canonical agent roles", () => {
  test("exports Cortex, Flux, and Zen from separate role modules", () => {
    expect(ROLE_IDS).toEqual(["cortex", "flux", "zen"]);
    expect(ROLES).toEqual({ cortex: CORTEX_ROLE, flux: FLUX_ROLE, zen: ZEN_ROLE });
    expect(ROLES.cortex.name).toBe("Cortex");
    expect(ROLES.flux.name).toBe("Flux");
    expect(ROLES.zen.name).toBe("Zen");
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
  });

  test("preserves the exact current six-section prompts", () => {
    const hashes = Object.fromEntries(ROLE_IDS.map(id => [
      id,
      createHash("sha256").update(composePrompt(ROLES[id])).digest("hex"),
    ]));

    expect(hashes).toEqual({
      cortex: "f05aec141f93cced6678ecfe7c9903466fbca23cb287ffd762d4aa734c91ad28",
      flux: "70786ecab733deda373afa7389ce3dc0e726e07f6126f6cc375c5ecbfc895bfe",
      zen: "2aa2d561ea2660f96735775bac80d5a2338a92ae762cdf953bbdd74c87fe3dfd",
    });
  });

  test("creates the current Mastra delegation topology", async () => {
    const agents = createToolkitAgents({ workspaceRoot: process.cwd(), browser: false });

    expect(Object.keys(agents)).toEqual(["cortex", "flux", "zen"]);
    expect(Object.keys(await agents.zen.listAgents())).toEqual(["cortex", "flux"]);
    expect(Object.keys(await agents.cortex.listAgents())).toEqual([]);
    expect(Object.keys(await agents.flux.listAgents())).toEqual([]);
  });

  test("assigns canonical tools and removes host commands during delegated runs", async () => {
    const agents = createToolkitAgents({ workspaceRoot: process.cwd(), browser: false });
    const delegatedContext = new RequestContext<unknown>([[TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY, true]]);

    expect(Object.keys(await agents.cortex.listTools())).toEqual(["command_run"]);
    expect(Object.keys(await agents.flux.listTools())).toEqual(["command_run", "adhd_run"]);
    expect(Object.keys(await agents.zen.listTools())).toEqual(["command_run"]);
    expect(Object.keys(await agents.cortex.listTools({ requestContext: delegatedContext }))).toEqual([]);
  });

  test("configures visible browser support for every canonical agent", () => {
    const agents = createToolkitAgents({ workspaceRoot: process.cwd(), browser: true });

    expect(agents.cortex.browser).toBeDefined();
    expect(agents.flux.browser).toBeDefined();
    expect(agents.zen.browser).toBeDefined();
  });

  test("runs injected tool hooks without removing audit events", async () => {
    const beforeToolCall = vi.fn();
    const afterToolCall = vi.fn();
    const audit = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const agents = createToolkitAgents({
      workspaceRoot: process.cwd(),
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
      "factory.ts",
      "prompt.ts",
    ].map(path => readFile(join(sourceRoot, path), "utf8")));

    expect(source.join("\n")).not.toMatch(/agent-controller|createCodeModes|prepareAgentControllerMount/);
  });
});
