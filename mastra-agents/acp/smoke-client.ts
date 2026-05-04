#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type Agent, type Client, type SessionNotification } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

class SmokeClient implements Client {
  readonly updates: SessionNotification[] = [];
  agentText = '';

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params);
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.agentText += update.content.text;
    }
  }

  async requestPermission() {
    return { outcome: { outcome: 'cancelled' as const } };
  }

  async readTextFile() {
    return { content: '' };
  }

  async writeTextFile() {
    return {};
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(__dirname, 'stdio.js');
const promptText = argValue('--prompt') ?? 'Reply with exactly ACP_SMOKE_OK.';
const skipPrompt = process.argv.includes('--handshake-only');

const child = spawn(process.execPath, [
  agentPath,
  '--agent-id',
  argValue('--agent-id') ?? process.env.MASTRA_ACP_AGENT_ID ?? 'supervisor-agent',
  '--cwd',
  argValue('--cwd') ?? process.cwd(),
  '--mastra-base-url',
  argValue('--mastra-base-url') ?? process.env.MASTRA_BASE_URL ?? process.env.MASTRA_ACP_BASE_URL ?? 'http://localhost:4111',
], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', chunk => {
  stderr += chunk.toString();
});

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
const client = new SmokeClient();
const connection = new ClientSideConnection((_agent: Agent) => client, stream);

try {
  const initialize = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: 'mastra-acp-smoke-client', version: '0.1.0' },
  });
  const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
  const setMode = await connection.setSessionMode({ sessionId: session.sessionId, modeId: 'balanced' });
  const setModel = await connection.unstable_setSessionModel?.({ sessionId: session.sessionId, modelId: session.models?.currentModelId ?? 'gpt-5.3-codex' });
  const setConfig = await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: 'thinking', value: 'medium' });

  const result = skipPrompt ? undefined : await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });

  console.log(JSON.stringify({
    ok: true,
    initialize,
    session,
    setMode,
    setModel,
    setConfig,
    prompt: result,
    agentText: client.agentText,
    updateCount: client.updates.length,
    updateTypes: [...new Set(client.updates.map(update => update.update.sessionUpdate))],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stderr,
  }, null, 2));
  process.exitCode = 1;
} finally {
  child.kill();
}
