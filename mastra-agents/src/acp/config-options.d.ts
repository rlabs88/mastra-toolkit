import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { MastraAcpSession } from './types.js';
export declare const AVAILABLE_MODES: string[];
export declare const AVAILABLE_MODELS: string[];
export declare function buildConfigOptions(session: MastraAcpSession): SessionConfigOption[];
