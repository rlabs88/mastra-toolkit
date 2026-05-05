import { createHash, randomUUID } from 'node:crypto';
import type { MastraAcpSession } from './types.js';

export class MastraAcpSessionStore {
  private readonly sessions = new Map<string, MastraAcpSession>();

  create(params: {
    sessionId?: string;
    agentId: string;
    cwd: string;
    resourceId?: string;
    threadId?: string;
    defaultModeId: string;
    defaultModelId: string;
  }): MastraAcpSession {
    const sessionId = params.sessionId ?? randomUUID();
    const now = new Date().toISOString();
    const session: MastraAcpSession = {
      sessionId,
      agentId: params.agentId,
      cwd: params.cwd,
      resourceId: params.resourceId ?? `acp:${shortHash(params.cwd)}`,
      threadId: params.threadId ?? `acp:${sessionId}:${params.agentId}`,
      modeId: params.defaultModeId,
      modelId: params.defaultModelId,
      thinkingOptionId: 'medium',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): MastraAcpSession | undefined { return this.sessions.get(sessionId); }
  update(session: MastraAcpSession): void { session.updatedAt = new Date().toISOString(); this.sessions.set(session.sessionId, session); }
  delete(sessionId: string): void { this.sessions.delete(sessionId); }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
