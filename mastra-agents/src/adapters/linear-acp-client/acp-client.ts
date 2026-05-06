import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import type { LinearAcpClientConfig } from "./config.js";
import type { LinearAcpRuntimeClient } from "./types.js";

type Runtime = {
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  client: LinearAcpClientProtocolClient;
  acpSessionId?: string;
  stderr: string;
};

export class StdioLinearAcpRuntimeClient implements LinearAcpRuntimeClient {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(private readonly config: Pick<LinearAcpClientConfig, "acpCommand" | "acpArgs" | "acpCwd">) {}

  async runPrompt(params: {
    linearAgentSessionId: string;
    acpSessionId?: string;
    prompt: string;
    onSessionId: (acpSessionId: string) => Promise<void> | void;
    onUpdate: (notification: SessionNotification) => Promise<void> | void;
  }): Promise<{ acpSessionId: string; stopReason?: string }> {
    const runtime = await this.runtimeFor(params.linearAgentSessionId, params.onUpdate);
    runtime.client.onUpdate = params.onUpdate;

    if (!runtime.acpSessionId) {
      await runtime.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "linear-acp-client", version: "0.1.0" },
      });
      const session = await runtime.connection.newSession({ cwd: this.config.acpCwd, mcpServers: [] });
      runtime.acpSessionId = session.sessionId;
      await params.onSessionId(session.sessionId);
    }

    const acpSessionId = runtime.acpSessionId;
    if (!acpSessionId) throw new Error("ACP session was not initialized");

    const result = await runtime.connection.prompt({
      sessionId: acpSessionId,
      prompt: [{ type: "text", text: params.prompt }],
    });

    return { acpSessionId, stopReason: result.stopReason };
  }

  async cancel(linearAgentSessionId: string): Promise<void> {
    const runtime = this.runtimes.get(linearAgentSessionId);
    if (runtime?.acpSessionId) {
      await runtime.connection.cancel({ sessionId: runtime.acpSessionId });
    }
  }

  async close(linearAgentSessionId: string): Promise<void> {
    const runtime = this.runtimes.get(linearAgentSessionId);
    if (!runtime) return;
    this.runtimes.delete(linearAgentSessionId);
    if (runtime.acpSessionId) {
      await runtime.connection.closeSession({ sessionId: runtime.acpSessionId }).catch(() => undefined);
    }
    runtime.child.kill();
  }

  private async runtimeFor(
    linearAgentSessionId: string,
    onUpdate: (notification: SessionNotification) => Promise<void> | void,
  ): Promise<Runtime> {
    const existing = this.runtimes.get(linearAgentSessionId);
    if (existing && !existing.child.killed && existing.child.exitCode == null) return existing;

    const child = spawn(this.config.acpCommand, this.config.acpArgs, {
      cwd: this.config.acpCwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", () => {
      const current = this.runtimes.get(linearAgentSessionId);
      if (current?.child === child) this.runtimes.delete(linearAgentSessionId);
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const client = new LinearAcpClientProtocolClient(onUpdate);
    const connection = new ClientSideConnection((_agent: Agent) => client, stream);
    const runtime = { child, connection, client, stderr };
    this.runtimes.set(linearAgentSessionId, runtime);
    return runtime;
  }
}

class LinearAcpClientProtocolClient implements Client {
  constructor(public onUpdate: (notification: SessionNotification) => Promise<void> | void) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    await this.onUpdate(params);
  }

  async requestPermission() {
    return { outcome: { outcome: "cancelled" as const } };
  }
}
