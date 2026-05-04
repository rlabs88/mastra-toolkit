import type { MastraAcpSession } from './types.js';
export declare class MastraAcpSessionStore {
    private readonly sessions;
    create(params: {
        sessionId?: string;
        agentId: string;
        cwd: string;
        resourceId?: string;
        threadId?: string;
    }): MastraAcpSession;
    get(sessionId: string): MastraAcpSession | undefined;
    update(session: MastraAcpSession): void;
    delete(sessionId: string): void;
}
