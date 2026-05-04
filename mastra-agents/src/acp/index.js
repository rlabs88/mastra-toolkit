import { createMastraAcpAgentHandler } from './adapter.js';
export * from './types.js';
export * from './adapter.js';
export function createMastraAcpAgent(options) {
    return (conn) => createMastraAcpAgentHandler(conn, options);
}
