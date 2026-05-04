import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { ACPAgent, MastraAcpAgentOptions } from './types.js';
export declare function createMastraAcpAgentHandler(conn: AgentSideConnection, options: MastraAcpAgentOptions): ACPAgent;
