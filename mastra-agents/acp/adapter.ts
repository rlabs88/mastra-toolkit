import type { AgentSideConnection, InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest, SetSessionModelRequest, SetSessionModelResponse } from '@agentclientprotocol/sdk';
import path from 'node:path';
import { buildConfigOptions, loadAcpRuntimeConfig, modeDefinitionForSession, modelOptionsForSession, normalizeModeId, normalizeModelId, type AcpRuntimeConfig } from './config-options.js';
import { createMastraChunkMapper } from './event-mapper.js';
import { streamMastraAgent } from './mastra-stream.js';
import { MastraAcpSessionStore } from './session-store.js';
import type { ACPAgent, MastraAcpAgentOptions, MastraAcpSession } from './types.js';
import { getSlashCommands } from './slash-commands.js';
import { resolveThinkingProviderOptions } from './thinking-options.js';

export function createMastraAcpAgentHandler(conn: AgentSideConnection, options: MastraAcpAgentOptions): ACPAgent {
  const store = new MastraAcpSessionStore(options.memoryStore);
  const runtimeConfig = () => loadAcpRuntimeConfig(options.agentId, options.mastraBaseUrl);
  return {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      return {
        protocolVersion: _params.protocolVersion,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {} },
        },
        agentInfo: { name: 'Mastra ACP Agent', version: '0.1.0' },
        authMethods: [],
      };
    },
    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      const config = await runtimeConfig();
      const cwd = resolveSessionCwd(params.cwd, options.cwd);
      const session = await store.create({
        agentId: options.agentId,
        cwd,
        resourceId: options.defaultResourceId,
        threadId: options.defaultThreadId,
        defaultModeId: config.defaultModeId,
        defaultModelId: config.defaultModelId,
      });
      await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: getSlashCommands() } });
      return newSessionStateResponse(session, config);
    },
    async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
      const config = await runtimeConfig();
      const cwd = resolveSessionCwd(params.cwd, options.cwd);
      const session = await store.load({
        sessionId: params.sessionId,
        agentId: options.agentId,
        cwd,
        resourceId: options.defaultResourceId,
        threadId: options.defaultThreadId ?? params.sessionId,
        defaultModeId: config.defaultModeId,
        defaultModelId: config.defaultModelId,
      });
      await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: getSlashCommands() } });
      return sessionStateResponse(session, config);
    },
    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const config = await runtimeConfig();
      const session = store.get(params.sessionId);
      if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
      const last = params.prompt.findLast((b) => b.type === 'text' && typeof b.text === 'string');
      const content = (last && 'text' in last) ? last.text : '';
      const ac = new AbortController();
      session.abortController = ac; await store.update(session);
      const mapMastraChunkToUpdates = createMastraChunkMapper();
      for await (const chunk of streamMastraAgent(options.mastraBaseUrl, session.agentId, buildPromptPayload(session, content, config), ac.signal)) {
        for (const update of mapMastraChunkToUpdates(chunk)) {
          await conn.sessionUpdate({ sessionId: session.sessionId, update });
        }
      }
      return { stopReason: ac.signal.aborted ? 'cancelled' : 'end_turn' };
    },
    async cancel(params) { const s = store.get(params.sessionId); s?.abortController?.abort(); },
    async closeSession(params) { await store.close(params.sessionId); },
    async setSessionMode(params: SetSessionModeRequest) {
      const config = await runtimeConfig();
      const s = store.get(params.sessionId); if (!s) throw new Error(`Unknown session: ${params.sessionId}`);
      s.modeId = normalizeModeId(params.modeId, config); await store.update(s);
      await emitSessionConfigUpdate(conn, s, config, true);
      return {};
    },
    async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
      const config = await runtimeConfig();
      const s = store.get(params.sessionId); if (!s) throw new Error(`Unknown session: ${params.sessionId}`);
      s.modelId = normalizeModelId(params.modelId, config); await store.update(s);
      await emitSessionConfigUpdate(conn, s, config, false);
      return {};
    },
    async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
      const config = await runtimeConfig();
      const s = store.get(params.sessionId); if (!s) throw new Error(`Unknown session: ${params.sessionId}`);
      let modeChanged = false;
      if (typeof params.value === 'string') {
        if (params.configId === 'mode') {
          s.modeId = normalizeModeId(params.value, config);
          modeChanged = true;
        }
        if (params.configId === 'model') s.modelId = normalizeModelId(params.value, config);
        if (params.configId === 'thinking') s.thinkingOptionId = params.value;
      }
      await store.update(s);
      const configOptions = buildConfigOptions(s, config);
      await emitSessionConfigUpdate(conn, s, config, modeChanged);
      return { configOptions };
    },
    async authenticate() {},
  };
}

function resolveSessionCwd(clientCwd: string, configuredCwd: string): string {
  if (path.isAbsolute(clientCwd)) return clientCwd;
  if (path.win32.isAbsolute(clientCwd) && path.isAbsolute(configuredCwd)) return configuredCwd;
  return configuredCwd || clientCwd;
}

function newSessionStateResponse(session: MastraAcpSession, config: AcpRuntimeConfig): NewSessionResponse {
  return {
    sessionId: session.sessionId,
    ...sessionStateResponse(session, config),
  };
}

function sessionStateResponse(session: MastraAcpSession, config: AcpRuntimeConfig): LoadSessionResponse {
  const modeId = normalizeModeId(session.modeId, config);
  const modelId = normalizeModelId(session.modelId, config);
  return {
    modes: {
      availableModes: config.modes.map(mode=>({id:mode.id,name:mode.name})),
      currentModeId: modeId,
    },
    models: {
      availableModels: modelOptionsForSession(session, config).map(modelId=>({modelId,name:modelId})),
      currentModelId: modelId,
    },
    configOptions: buildConfigOptions(session, config),
  };
}

async function emitSessionConfigUpdate(conn: AgentSideConnection, session: MastraAcpSession, config: AcpRuntimeConfig, modeChanged: boolean): Promise<void> {
  const modeId = normalizeModeId(session.modeId, config);
  const configOptions = buildConfigOptions(session, config);
  if (modeChanged) {
    await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } });
  }
  await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'config_option_update', configOptions } });
}

function buildPromptPayload(session: MastraAcpSession, content: string, config: AcpRuntimeConfig) {
  const mode = modeDefinitionForSession(session, config);
  const modeId = mode.id;
  const modelId = normalizeModelId(session.modelId, config);
  const thinkingOptions = resolveThinkingProviderOptions({ modelId, thinkingLevel: session.thinkingOptionId });
  const effectiveModelId = thinkingOptions.modelId ?? modelId;
  return {
    messages: [{ role: 'user', content: `${mode.prompt}\n\n${content}` }],
    memory: { thread: session.threadId, resource: session.resourceId },
    model: effectiveModelId,
    ...(thinkingOptions.providerOptions ? { providerOptions: thinkingOptions.providerOptions } : {}),
    requestContext: {
      acp: {
        sessionId: session.sessionId,
        cwd: session.cwd,
        modeId,
        modelId: effectiveModelId,
        selectedModelId: modelId,
        thinkingOptionId: session.thinkingOptionId,
        thinking: thinkingOptions.metadata,
      },
      activeAgentId: mode.agentId,
      modeId,
      modelId: effectiveModelId,
      harnessMode: mode.harnessMode,
      harnessModeId: mode.harnessModeId,
      hardnessMode: mode.harnessModeId,
      ...(mode.agentId === 'supervisor' ? { supervisorScope: mode.harnessMode } : { orchestratorMode: mode.harnessMode }),
    },
  };
}
