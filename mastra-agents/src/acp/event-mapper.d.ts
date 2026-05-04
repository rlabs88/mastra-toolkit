import type { SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';
export declare function inferToolKind(name?: string): ToolCallUpdate['kind'];
export declare function mapMastraChunkToUpdates(chunk: unknown): SessionUpdate[];
