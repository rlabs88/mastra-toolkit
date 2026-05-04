import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { MastraAcpAgentOptions } from './types.js';
export * from './types.js';
export * from './adapter.js';
export declare function createMastraAcpAgent(options: MastraAcpAgentOptions): (conn: AgentSideConnection) => import("@agentclientprotocol/sdk").Agent;
