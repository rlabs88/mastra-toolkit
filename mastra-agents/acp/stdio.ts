#!/usr/bin/env node
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { createMastraAcpAgent } from './index.js';

interface CliOptions {
  agentId: string;
  cwd: string;
  mastraBaseUrl?: string;
}

function readCliOptions(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const options: CliOptions = {
    agentId: env.MASTRA_ACP_AGENT_ID ?? 'supervisor-agent',
    cwd: env.MASTRA_ACP_CWD ?? process.cwd(),
    mastraBaseUrl: env.MASTRA_BASE_URL ?? env.MASTRA_ACP_BASE_URL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--agent-id' && next) {
      options.agentId = next;
      i += 1;
    } else if (arg === '--cwd' && next) {
      options.cwd = next;
      i += 1;
    } else if (arg === '--mastra-base-url' && next) {
      options.mastraBaseUrl = next;
      i += 1;
    }
  }

  return options;
}

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(output, input);
const agent = createMastraAcpAgent(readCliOptions(process.argv.slice(2), process.env));
const connection = new AgentSideConnection(agent, stream);

await connection.closed;
