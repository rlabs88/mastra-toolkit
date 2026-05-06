import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { MastraAcpMemoryStore, MastraAcpMemoryThread, MastraAcpSession } from './types.js';

const ACP_METADATA_KEY = 'acp';

interface AcpThreadMetadata {
  sessionId?: string;
  agentId?: string;
  localCwd?: string;
  threadId?: string;
  resourceId?: string;
  resourceIdSource?: MastraAcpSession['resourceIdSource'];
  modeId?: string;
  modelId?: string;
  thinkingOptionId?: string;
  status?: 'active' | 'closed';
  loadedFromDurableStore?: boolean;
  recoveredFromFallback?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export class MastraAcpSessionStore {
  private readonly sessions = new Map<string, MastraAcpSession>();

  constructor(private readonly memoryStore?: MastraAcpMemoryStore) {}

  async create(params: {
    sessionId?: string;
    agentId: string;
    cwd: string;
    resourceId?: string;
    threadId?: string;
    defaultModeId: string;
    defaultModelId: string;
    recoveredFromFallback?: boolean;
  }): Promise<MastraAcpSession> {
    const sessionId = params.sessionId ?? randomUUID();
    const now = new Date().toISOString();
    const cwd = normalizeCwd(params.cwd);
    const resourceId = nonEmpty(params.resourceId) ?? workspaceResourceId(cwd);
    const resourceIdSource: MastraAcpSession['resourceIdSource'] = nonEmpty(params.resourceId) ? 'provided' : 'workspace_fallback';
    const session: MastraAcpSession = {
      sessionId,
      agentId: params.agentId,
      cwd,
      resourceId,
      resourceIdSource,
      threadId: nonEmpty(params.threadId) ?? sessionId,
      recoveredFromFallback: params.recoveredFromFallback,
      modeId: params.defaultModeId,
      modelId: params.defaultModelId,
      thinkingOptionId: 'medium',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    await this.persist(session, 'active');
    return session;
  }

  async load(params: {
    sessionId: string;
    agentId: string;
    cwd: string;
    resourceId?: string;
    threadId?: string;
    defaultModeId: string;
    defaultModelId: string;
  }): Promise<MastraAcpSession> {
    const requestedCwd = normalizeCwd(params.cwd);
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      assertSessionCwd(existing, requestedCwd);
      return existing;
    }

    const requestedThreadId = nonEmpty(params.threadId) ?? params.sessionId;
    const durableThread = await this.memoryStore?.getThreadById({ threadId: requestedThreadId });
    if (!durableThread) {
      return this.create({
        sessionId: params.sessionId,
        agentId: params.agentId,
        cwd: requestedCwd,
        resourceId: params.resourceId,
        threadId: requestedThreadId,
        defaultModeId: params.defaultModeId,
        defaultModelId: params.defaultModelId,
        recoveredFromFallback: true,
      });
    }

    const metadata = getAcpMetadata(durableThread);
    const storedCwd = nonEmpty(metadata.localCwd);
    if (storedCwd && normalizeCwd(storedCwd) !== requestedCwd) {
      throw new Error(`ACP session cwd mismatch for ${params.sessionId}: stored ${storedCwd}, requested ${requestedCwd}`);
    }
    if (nonEmpty(metadata.resourceId) && metadata.resourceId !== durableThread.resourceId) {
      throw new Error(`ACP session resourceId mismatch for ${params.sessionId}`);
    }
    if (nonEmpty(params.resourceId) && params.resourceId !== durableThread.resourceId) {
      throw new Error(`ACP session resourceId mismatch for ${params.sessionId}`);
    }
    if (nonEmpty(metadata.threadId) && metadata.threadId !== durableThread.id) {
      throw new Error(`ACP session threadId mismatch for ${params.sessionId}`);
    }
    if (nonEmpty(metadata.sessionId) && metadata.sessionId !== params.sessionId) {
      throw new Error(`ACP session id mismatch for ${params.sessionId}`);
    }

    const now = new Date().toISOString();
    const session: MastraAcpSession = {
      sessionId: params.sessionId,
      agentId: nonEmpty(metadata.agentId) ?? params.agentId,
      cwd: requestedCwd,
      threadId: durableThread.id,
      resourceId: durableThread.resourceId,
      resourceIdSource: metadata.resourceIdSource ?? (nonEmpty(params.resourceId) ? 'provided' : 'workspace_fallback'),
      loadedFromDurableStore: true,
      recoveredFromFallback: metadata.recoveredFromFallback,
      modeId: nonEmpty(metadata.modeId) ?? params.defaultModeId,
      modelId: nonEmpty(metadata.modelId) ?? params.defaultModelId,
      thinkingOptionId: nonEmpty(metadata.thinkingOptionId) ?? 'medium',
      createdAt: nonEmpty(metadata.createdAt) ?? durableThread.createdAt.toISOString(),
      updatedAt: now,
    };
    this.sessions.set(session.sessionId, session);
    await this.persist(session, 'active');
    return session;
  }

  get(sessionId: string): MastraAcpSession | undefined { return this.sessions.get(sessionId); }
  async update(session: MastraAcpSession): Promise<void> {
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.sessionId, session);
    await this.persist(session, 'active');
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    session?.abortController?.abort();
    if (session) await this.persist(session, 'closed');
    this.sessions.delete(sessionId);
  }

  private async persist(session: MastraAcpSession, status: 'active' | 'closed'): Promise<void> {
    if (!this.memoryStore) return;
    const existing = await this.memoryStore.getThreadById({ threadId: session.threadId });
    const now = new Date();
    const createdAt = existing?.createdAt ?? new Date(session.createdAt);
    await this.memoryStore.saveThread({
      thread: {
        id: session.threadId,
        resourceId: session.resourceId,
        title: existing?.title,
        metadata: mergeAcpMetadata(existing?.metadata, session, status),
        createdAt,
        updatedAt: now,
      },
    });
  }
}

function assertSessionCwd(session: MastraAcpSession, requestedCwd: string): void {
  if (session.cwd !== requestedCwd) {
    throw new Error(`ACP session cwd mismatch for ${session.sessionId}: stored ${session.cwd}, requested ${requestedCwd}`);
  }
}

function normalizeCwd(cwd: string): string {
  const value = nonEmpty(cwd);
  if (!value) throw new Error('ACP session cwd is required');
  if (!path.isAbsolute(value)) throw new Error(`ACP session cwd must be absolute: ${value}`);
  return path.normalize(value);
}

function workspaceResourceId(cwd: string): string {
  return `acp:workspace:${shortHash(cwd)}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getAcpMetadata(thread: MastraAcpMemoryThread): AcpThreadMetadata {
  const candidate = thread.metadata?.[ACP_METADATA_KEY];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  return candidate as AcpThreadMetadata;
}

function mergeAcpMetadata(
  metadata: Record<string, unknown> | undefined,
  session: MastraAcpSession,
  status: 'active' | 'closed',
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [ACP_METADATA_KEY]: {
      ...getAcpMetadata({
        id: session.threadId,
        resourceId: session.resourceId,
        metadata,
        createdAt: new Date(session.createdAt),
        updatedAt: new Date(session.updatedAt),
      }),
      sessionId: session.sessionId,
      agentId: session.agentId,
      localCwd: session.cwd,
      threadId: session.threadId,
      resourceId: session.resourceId,
      resourceIdSource: session.resourceIdSource,
      modeId: session.modeId,
      modelId: session.modelId,
      thinkingOptionId: session.thinkingOptionId,
      status,
      loadedFromDurableStore: session.loadedFromDurableStore,
      recoveredFromFallback: session.recoveredFromFallback,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
    },
  };
}
