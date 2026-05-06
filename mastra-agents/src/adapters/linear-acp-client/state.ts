import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LinearAcpClientSessionBinding, LinearAcpClientStateStore } from "./types.js";

type StoredState = {
  sessions: Record<string, LinearAcpClientSessionBinding>;
  webhookDeliveries: Record<string, { linearAgentSessionId: string; processedAt: string }>;
};

const emptyState = (): StoredState => ({ sessions: {}, webhookDeliveries: {} });

export class FileLinearAcpClientStateStore implements LinearAcpClientStateStore {
  constructor(private readonly filePath: string) {}

  async getSession(linearAgentSessionId: string): Promise<LinearAcpClientSessionBinding | undefined> {
    const state = await this.read();
    return state.sessions[linearAgentSessionId];
  }

  async saveSession(binding: LinearAcpClientSessionBinding): Promise<void> {
    const state = await this.read();
    state.sessions[binding.linearAgentSessionId] = {
      ...binding,
      updatedAt: new Date().toISOString(),
    };
    await this.write(state);
  }

  async hasProcessedWebhook(webhookId: string): Promise<boolean> {
    const state = await this.read();
    return Boolean(state.webhookDeliveries[webhookId]);
  }

  async markWebhookProcessed(webhookId: string, linearAgentSessionId: string): Promise<void> {
    const state = await this.read();
    state.webhookDeliveries[webhookId] = {
      linearAgentSessionId,
      processedAt: new Date().toISOString(),
    };
    const binding = state.sessions[linearAgentSessionId];
    if (binding && !binding.processedWebhookIds.includes(webhookId)) {
      binding.processedWebhookIds.push(webhookId);
      binding.updatedAt = new Date().toISOString();
    }
    await this.write(state);
  }

  private async read(): Promise<StoredState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoredState>;
      return {
        sessions: parsed.sessions ?? {},
        webhookDeliveries: parsed.webhookDeliveries ?? {},
      };
    } catch (error) {
      if (isMissingFileError(error)) return emptyState();
      throw error;
    }
  }

  private async write(state: StoredState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}

export class MemoryLinearAcpClientStateStore implements LinearAcpClientStateStore {
  private state = emptyState();

  async getSession(linearAgentSessionId: string): Promise<LinearAcpClientSessionBinding | undefined> {
    return this.state.sessions[linearAgentSessionId];
  }

  async saveSession(binding: LinearAcpClientSessionBinding): Promise<void> {
    this.state.sessions[binding.linearAgentSessionId] = {
      ...binding,
      updatedAt: new Date().toISOString(),
    };
  }

  async hasProcessedWebhook(webhookId: string): Promise<boolean> {
    return Boolean(this.state.webhookDeliveries[webhookId]);
  }

  async markWebhookProcessed(webhookId: string, linearAgentSessionId: string): Promise<void> {
    this.state.webhookDeliveries[webhookId] = {
      linearAgentSessionId,
      processedAt: new Date().toISOString(),
    };
    const binding = this.state.sessions[linearAgentSessionId];
    if (binding && !binding.processedWebhookIds.includes(webhookId)) {
      binding.processedWebhookIds.push(webhookId);
      binding.updatedAt = new Date().toISOString();
    }
  }
}

export function createInitialBinding(params: {
  linearAgentSessionId: string;
  linearIssueId?: string;
  linearRootCommentId?: string;
  linearSourceCommentId?: string;
  linearSessionUrl?: string;
}): LinearAcpClientSessionBinding {
  const now = new Date().toISOString();
  return {
    linearAgentSessionId: params.linearAgentSessionId,
    linearIssueId: params.linearIssueId,
    linearRootCommentId: params.linearRootCommentId,
    linearSourceCommentId: params.linearSourceCommentId,
    linearSessionUrl: params.linearSessionUrl,
    processedWebhookIds: [],
    emittedEventIds: [],
    responseTextByTurn: {},
    thoughtTextByTurn: {},
    toolSnapshots: {},
    createdAt: now,
    updatedAt: now,
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
