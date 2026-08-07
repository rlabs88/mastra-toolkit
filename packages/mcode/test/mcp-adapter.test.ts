import type { McpManager } from "@mastra/code-sdk/mcp/index";
import { describe, expect, test } from "vitest";
import { CodeMcpAdapter } from "../src/index.js";

describe("CodeMcpAdapter", () => {
  test("restores the active MCP generation when a later host commit rolls back", async () => {
    const first = fakeManager({ first_tool: {} });
    const second = fakeManager({ second_tool: {} });
    const candidates = [first, second];
    const adapter = new CodeMcpAdapter(() => candidates.shift()!.manager);

    const initial = await adapter.prepare();
    await initial.commit();
    expect(adapter.getTools()).toEqual({ first_tool: {} });

    const replacement = await adapter.prepare();
    await replacement.commit();
    expect(adapter.getTools()).toEqual({ second_tool: {} });

    await replacement.rollback();
    expect(adapter.getTools()).toEqual({ first_tool: {} });
    expect(second.disconnects()).toBe(1);

    const third = fakeManager({ third_tool: {} });
    candidates.push(third);
    const retired = await adapter.prepare();
    await retired.commit();
    await retired.retirePrevious?.();
    expect(first.disconnects()).toBe(1);

    await adapter.close();
    expect(third.disconnects()).toBe(1);
  });

  test("keeps connected MCP tools when an optional server fails", async () => {
    const candidate = fakeManager({ surviving_tool: {} }, [{ name: "browseros" }]);
    const adapter = new CodeMcpAdapter(() => candidate.manager);

    const generation = await adapter.prepare();
    await generation.commit();

    expect(adapter.getTools()).toEqual({ surviving_tool: {} });
    expect(candidate.disconnects()).toBe(0);

    await adapter.close();
    expect(candidate.disconnects()).toBe(1);
  });

  test("rejects a partial replacement so reload can retain the active generation", async () => {
    const active = fakeManager({ active_tool: {} });
    const partial = fakeManager({ partial_tool: {} }, [{ name: "browseros" }]);
    const candidates = [active, partial];
    const adapter = new CodeMcpAdapter(() => candidates.shift()!.manager);

    const initial = await adapter.prepare();
    await initial.commit();

    await expect(adapter.prepare()).rejects.toThrow(/browseros/);
    expect(adapter.getTools()).toEqual({ active_tool: {} });
    expect(active.disconnects()).toBe(0);
    expect(partial.disconnects()).toBe(1);

    await adapter.close();
    expect(active.disconnects()).toBe(1);
  });

  test("disconnects a replacement whose initialization rejects", async () => {
    const active = fakeManager({ active_tool: {} });
    const rejected = fakeManager({}, [], new Error("startup exploded"));
    const candidates = [active, rejected];
    const adapter = new CodeMcpAdapter(() => candidates.shift()!.manager);

    const initial = await adapter.prepare();
    await initial.commit();

    await expect(adapter.prepare()).rejects.toThrow("startup exploded");
    expect(adapter.getTools()).toEqual({ active_tool: {} });
    expect(rejected.disconnects()).toBe(1);

    await adapter.close();
  });
});

function fakeManager(
  tools: Record<string, unknown>,
  failed: readonly { name: string }[] = [],
  initError?: Error,
): {
  manager: McpManager;
  disconnects(): number;
} {
  let disconnectCount = 0;
  return {
    manager: {
      initInBackground: async () => {
        if (initError) throw initError;
        return { connected: [], failed, skipped: [], totalTools: Object.keys(tools).length };
      },
      getTools: () => tools,
      disconnect: async () => { disconnectCount += 1; },
    } as unknown as McpManager,
    disconnects: () => disconnectCount,
  };
}
