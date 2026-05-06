import type { Agent } from '@agentclientprotocol/sdk';

export interface MastraAcpAgentOptions {
  agentId: string;
  cwd: string;
  mastraBaseUrl?: string;
  defaultResourceId?: string;
  defaultThreadId?: string;
  memoryStore?: MastraAcpMemoryStore;
}

export interface MastraAcpSession {
  sessionId: string;
  agentId: string;
  cwd: string;
  threadId: string;
  resourceId: string;
  resourceIdSource?: 'provided' | 'workspace_fallback';
  loadedFromDurableStore?: boolean;
  recoveredFromFallback?: boolean;
  modeId?: string;
  modelId?: string;
  thinkingOptionId?: string;
  abortController?: AbortController;
  createdAt: string;
  updatedAt: string;
}

export interface MastraAcpMemoryThread {
  id: string;
  resourceId: string;
  title?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface MastraAcpMemoryStore {
  getThreadById(params: { threadId: string }): Promise<MastraAcpMemoryThread | null>;
  saveThread(params: { thread: MastraAcpMemoryThread }): Promise<MastraAcpMemoryThread>;
}

export type ACPAgent = Agent;
