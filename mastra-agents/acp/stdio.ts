#!/usr/bin/env node
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
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

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return trimmed;
  const body = trimmed.slice(1, -1);
  return quote === '"' ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"') : body;
}

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(filePath)) return values;

  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const assignment = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equalsIndex = assignment.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquoteEnvValue(assignment.slice(equalsIndex + 1));
  }

  return values;
}

function mergeNonEmpty(...sources: Array<Record<string, string>>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === '' && merged[key]) continue;
      merged[key] = value;
    }
  }
  return merged;
}

function loadProjectEnv(options: CliOptions): void {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const fileEnv = mergeNonEmpty(
    parseEnvFile(path.join(options.cwd, '.env')),
    parseEnvFile(path.join(packageRoot, '.env')),
  );

  for (const [key, value] of Object.entries(fileEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const options = readCliOptions(process.argv.slice(2), process.env);
loadProjectEnv(options);

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(output, input);
const agent = createMastraAcpAgent(options);
const connection = new AgentSideConnection(agent, stream);

await connection.closed;
