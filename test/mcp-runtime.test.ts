import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadMcpConfig } from "@mastra/code-sdk/mcp/config";
import type { McpManager } from "@mastra/code-sdk/mcp/index";
import { SwappableMcpRuntime, validateMcpConfigFiles } from "../src/project/mcp.js";

describe("MCP project configuration", () => {
  test("uses installed project precedence with .mastracode highest", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-mcp-precedence-"));
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, ".mastracode"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.local.json"), config("low"));
    await writeFile(join(root, ".mcp.json"), config("middle"));
    await writeFile(join(root, ".mastracode", "mcp.json"), config("high"));

    await validateMcpConfigFiles(root);
    const loaded = loadMcpConfig(root);

    expect(loaded.mcpServers?.example).toMatchObject({ command: "high" });
  });

  test("keeps the connected generation when a candidate manager fails", async () => {
    const first = fakeManager("first", false);
    const failed = fakeManager("failed", true);
    const candidates = [first, failed];
    const runtime = new SwappableMcpRuntime(() => candidates.shift()!);

    await runtime.reload();
    await expect(runtime.reload()).rejects.toThrow(/failed to connect/i);

    expect(Object.keys(runtime.getTools())).toEqual(["first_tool"]);
    expect(first.disconnectCalls).toBe(0);
    expect(failed.disconnectCalls).toBe(1);
  });

  test("rejects malformed JSON before replacing a connected manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "mastra-mcp-invalid-"));
    await writeFile(join(root, ".mcp.json"), "{");

    await expect(validateMcpConfigFiles(root)).rejects.toThrow(/invalid MCP JSON/i);
  });
});

function config(command: string): string {
  return JSON.stringify({ mcpServers: { example: { command } } });
}

function fakeManager(name: string, failed: boolean): McpManager & { disconnectCalls: number } {
  return {
    disconnectCalls: 0,
    async init() {},
    async initInBackground() {
      return {
        connected: failed ? [] : [{ name, connected: true, toolCount: 1, toolNames: [`${name}_tool`], transport: "stdio" as const }],
        failed: failed ? [{ name, connected: false, toolCount: 0, toolNames: [], transport: "stdio" as const, error: "boom" }] : [],
        skipped: [],
        totalTools: failed ? 0 : 1,
      };
    },
    async reload() {},
    async reconnectServer() { throw new Error("unused"); },
    async authenticateServer() { throw new Error("unused"); },
    async cancelServerAuthentication() { return false; },
    async disconnect() { this.disconnectCalls += 1; },
    getTools: () => ({ [`${name}_tool`]: { execute: async () => name } }),
    hasServers: () => true,
    getServerStatuses: () => [],
    getSkippedServers: () => [],
    getConfigPaths: () => ({ project: "", global: "", claude: "" }),
    getConfig: () => ({}),
    getServerLogs: () => [],
  };
}
