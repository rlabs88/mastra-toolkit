import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { MastraAcpSession } from './types.js';
export type AcpRuntimeAgentId = 'orchestrator' | 'supervisor';
export type AcpModeDefinition = {
    id: string;
    name: string;
    agentId: AcpRuntimeAgentId;
    harnessMode: string;
    harnessModeId: string;
    default: boolean;
    prompt: string;
};
export type AcpRuntimeConfig = {
    agentId: AcpRuntimeAgentId;
    modes: AcpModeDefinition[];
    defaultModeId: string;
    models: string[];
    defaultModelId: string;
};
export declare function runtimeAgentIdFromAgentId(agentId: string | undefined): AcpRuntimeAgentId;
export declare function loadAcpRuntimeConfig(agentId: string | undefined, mastraBaseUrl?: string): Promise<AcpRuntimeConfig>;
export declare function normalizeModeId(value: unknown, config: AcpRuntimeConfig): string;
export declare function normalizeModelId(value: unknown, config: AcpRuntimeConfig): string;
export declare function modeDefinitionForSession(session: MastraAcpSession, config: AcpRuntimeConfig): AcpModeDefinition;
export declare function modelOptionsForSession(session: MastraAcpSession, config: AcpRuntimeConfig): string[];
export declare function buildConfigOptions(session: MastraAcpSession, config: AcpRuntimeConfig): SessionConfigOption[];
