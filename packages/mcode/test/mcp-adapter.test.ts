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
});

function fakeManager(
  tools: Record<string, unknown>,
  failed: readonly { name: string }[] = [],
): {
  manager: McpManager;
  disconnects(): number;
} {
  let disconnectCount = 0;
  return {
    manager: {
      initInBackground: async () => ({ connected: [], failed, skipped: [], totalTools: Object.keys(tools).length }),
      getTools: () => tools,
      disconnect: async () => { disconnectCount += 1; },
    } as unknown as McpManager,
    disconnects: () => disconnectCount,
  };
}
