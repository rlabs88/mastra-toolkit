import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMcpManager, type McpManager, type McpServerConfig } from "@mastra/code-sdk/mcp/index";

export class SwappableMcpRuntime {
  readonly #createCandidate: () => McpManager;
  readonly #retired: McpManager[] = [];
  #current: McpManager | undefined;

  constructor(createCandidate: () => McpManager) {
    this.#createCandidate = createCandidate;
  }

  async reload(): Promise<void> {
    const candidate = this.#createCandidate();
    const result = await candidate.initInBackground();
    if (result.failed.length > 0) {
      await candidate.disconnect();
      throw new Error(`MCP candidate failed to connect: ${result.failed.map(server => server.name).join(", ")}`);
    }
    if (this.#current) this.#retired.push(this.#current);
    this.#current = candidate;
  }

  async rollback(): Promise<void> {
    const failed = this.#current;
    this.#current = this.#retired.pop();
    await failed?.disconnect();
  }

  getTools(): Record<string, unknown> {
    return this.#current?.getTools() ?? {};
  }

  async close(): Promise<void> {
    const managers = [...this.#retired, ...(this.#current ? [this.#current] : [])];
    this.#retired.length = 0;
    this.#current = undefined;
    await Promise.all(managers.map(manager => manager.disconnect()));
  }
}

export function createProjectMcpRuntime(
  projectRoot: string,
  programmaticServers?: Record<string, McpServerConfig>,
): SwappableMcpRuntime {
  return new SwappableMcpRuntime(() => createMcpManager(projectRoot, ".mastracode", programmaticServers));
}

export async function validateMcpConfigFiles(projectRoot: string): Promise<void> {
  const files = [
    join(projectRoot, ".claude", "settings.local.json"),
    join(homedir(), ".mastracode", "mcp.json"),
    join(projectRoot, ".mcp.json"),
    join(projectRoot, ".mastracode", "mcp.json"),
  ];
  for (const file of files) await validateJsonFile(file);
}

async function validateJsonFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid MCP JSON: ${path}`, { cause: error });
  }
}
