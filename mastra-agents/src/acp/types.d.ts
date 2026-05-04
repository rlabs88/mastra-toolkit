import type { Agent } from '@agentclientprotocol/sdk';
export interface MastraAcpAgentOptions {
    agentId: string;
    cwd: string;
    mastraBaseUrl?: string;
    defaultResourceId?: string;
    defaultThreadId?: string;
}
export interface MastraAcpSession {
    sessionId: string;
    agentId: string;
    cwd: string;
    threadId: string;
    resourceId: string;
    modeId?: string;
    modelId?: string;
    thinkingOptionId?: string;
    abortController?: AbortController;
    createdAt: string;
    updatedAt: string;
}
export type ACPAgent = Agent;
