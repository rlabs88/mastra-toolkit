import { createHash, randomUUID } from 'node:crypto';
export class MastraAcpSessionStore {
    sessions = new Map();
    create(params) {
        const sessionId = params.sessionId ?? randomUUID();
        const now = new Date().toISOString();
        const session = {
            sessionId,
            agentId: params.agentId,
            cwd: params.cwd,
            resourceId: params.resourceId ?? `acp:${shortHash(params.cwd)}`,
            threadId: params.threadId ?? `acp:${sessionId}:${params.agentId}`,
            createdAt: now,
            updatedAt: now,
        };
        this.sessions.set(sessionId, session);
        return session;
    }
    get(sessionId) { return this.sessions.get(sessionId); }
    update(session) { session.updatedAt = new Date().toISOString(); this.sessions.set(session.sessionId, session); }
    delete(sessionId) { this.sessions.delete(sessionId); }
}
function shortHash(value) {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
