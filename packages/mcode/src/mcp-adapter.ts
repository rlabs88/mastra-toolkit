import { createMcpManager, type McpManager, type McpServerConfig } from "@mastra/code-sdk/mcp/index";
import type {
  McpLifecyclePort,
  PreparedMcpGeneration,
} from "@rlabs/project-mounting-manager";

export class CodeMcpAdapter implements McpLifecyclePort {
  readonly #createCandidate: () => McpManager;
  readonly #retired: McpManager[] = [];
  #current: McpManager | undefined;

  constructor(createCandidate: () => McpManager) {
    this.#createCandidate = createCandidate;
  }

  async prepare(): Promise<PreparedMcpGeneration> {
    const candidate = this.#createCandidate();
    const result = await candidate.initInBackground();
    if (result.failed.length > 0) {
      await candidate.disconnect();
      throw new Error(`MCP candidate failed to connect: ${result.failed.map(server => server.name).join(", ")}`);
    }
    const previous = this.#current;
    let committed = false;
    let rolledBack = false;
    return {
      snapshot: () => candidate.getTools(),
      commit: async () => {
        if (committed || rolledBack) return;
        committed = true;
        if (previous) this.#retired.push(previous);
        this.#current = candidate;
      },
      rollback: async () => {
        if (rolledBack) return;
        rolledBack = true;
        if (committed) {
          this.#current = previous;
          if (previous) {
            const index = this.#retired.indexOf(previous);
            if (index >= 0) this.#retired.splice(index, 1);
          }
        }
        await candidate.disconnect();
      },
    };
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

export function createCodeMcpAdapter(
  projectRoot: string,
  programmaticServers?: Record<string, McpServerConfig>,
): CodeMcpAdapter {
  return new CodeMcpAdapter(() => createMcpManager(projectRoot, ".mastracode", programmaticServers));
}
