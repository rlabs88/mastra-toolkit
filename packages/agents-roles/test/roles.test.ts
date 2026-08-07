import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  CORTEX_ROLE,
  FLUX_ROLE,
  ROLE_IDS,
  ROLES,
  ZEN_ROLE,
  TOOLKIT_DELEGATED_RUN_CONTEXT_KEY,
  composePrompt,
  createToolkitAgents,
} from "../src/index.js";

describe("canonical agent roles", () => {
  test("exports the canonical Cortex, Flux, and Zen role definitions", () => {
    expect(ROLE_IDS).toEqual(["cortex", "flux", "zen"]);
    expect(ROLES).toEqual({ cortex: CORTEX_ROLE, flux: FLUX_ROLE, zen: ZEN_ROLE });
    expect(ROLES.cortex.name).toBe("Cortex");
    expect(ROLES.flux.name).toBe("Flux");
    expect(ROLES.zen.name).toBe("Zen");
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
  });

  test("preserves the exact current six-section prompts", () => {
    const hashes = Object.fromEntries(ROLE_IDS.map(id => [
      id,
      createHash("sha256").update(composePrompt(ROLES[id])).digest("hex"),
    ]));

    expect(hashes).toEqual({
      cortex: "08aab5280ec12e4c62c8d4989b4456cf084e01043a87e77951ff759f869b7751",
      flux: "585472db1469a48b0abd28d284871f7d7d15e381e68705225aaa883a9afa7f74",
      zen: "411351b9d27271fe546a4cdd879947d6e2b2ee717249cc3a1c3fd2341be81188",
    });
  });

  test("directs every role to native Mastra workspace tools", () => {
    for (const id of ROLE_IDS) {
      const prompt = composePrompt(ROLES[id]);
      expect(prompt).not.toMatch(/command_run|adhd_run/);
      expect(prompt).toMatch(/Mastra workspace/i);
    }
  });

  test("creates the current Mastra delegation topology", async () => {
    const agents = createToolkitAgents({ browser: false });

    expect(Object.keys(agents)).toEqual(["cortex", "flux", "zen"]);
    expect(Object.keys(await agents.zen.listAgents())).toEqual(["cortex", "flux"]);
    expect(Object.keys(await agents.cortex.listAgents())).toEqual([]);
    expect(Object.keys(await agents.flux.listAgents())).toEqual([]);
  });

  test("does not expose legacy command tools to top-level or delegated roles", async () => {
    const agents = createToolkitAgents({
      browser: false,
      additionalTools: {
        command_run: legacyToolFixture("command_run"),
        adhd_run: legacyToolFixture("adhd_run"),
      },
    });
    const delegatedContext = new RequestContext<unknown>([[TOOLKIT_DELEGATED_RUN_CONTEXT_KEY, true]]);

    for (const agent of Object.values(agents)) {
      expect(Object.keys(await agent.listTools())).not.toEqual(expect.arrayContaining(["command_run", "adhd_run"]));
      expect(Object.keys(await agent.listTools({ requestContext: delegatedContext })))
        .not.toEqual(expect.arrayContaining(["command_run", "adhd_run"]));
    }
  });

  test("configures visible browser support for every canonical agent", () => {
    const agents = createToolkitAgents({ browser: true });

    expect(agents.cortex.browser).toBeDefined();
    expect(agents.flux.browser).toBeDefined();
    expect(agents.zen.browser).toBeDefined();
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

function legacyToolFixture(id: string) {
  return createTool({
    id,
    description: "command fixture",
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  });
}
