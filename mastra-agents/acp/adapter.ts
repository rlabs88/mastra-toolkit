import type { AgentSideConnection, InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest, SetSessionModelRequest, SetSessionModelResponse } from '@agentclientprotocol/sdk';
import { buildConfigOptions, AVAILABLE_MODELS, AVAILABLE_MODES, normalizeModeId, normalizeModelId, type SupervisorModeId } from './config-options.js';
import { mapMastraChunkToUpdates } from './event-mapper.js';
import { streamMastraAgent } from './mastra-stream.js';
import { MastraAcpSessionStore } from './session-store.js';
import type { ACPAgent, MastraAcpAgentOptions, MastraAcpSession } from './types.js';
import { getSlashCommands } from './slash-commands.js';

export function createMastraAcpAgentHandler(conn: AgentSideConnection, options: MastraAcpAgentOptions): ACPAgent {
  const store = new MastraAcpSessionStore();
  return {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      return {
        protocolVersion: _params.protocolVersion,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: { name: 'Mastra ACP Agent', version: '0.1.0' },
        authMethods: [],
      };
    },
    async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
      const session = store.create({ agentId: options.agentId, cwd: options.cwd, resourceId: options.defaultResourceId, threadId: options.defaultThreadId });
      await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: getSlashCommands() } });
      return sessionStateResponse(session);
    },
    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const session = store.get(params.sessionId);
      if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
      const last = params.prompt.findLast((b) => b.type === 'text' && typeof b.text === 'string');
      const content = (last && 'text' in last) ? last.text : '';
      const ac = new AbortController();
      session.abortController = ac; store.update(session);
      for await (const chunk of streamMastraAgent(options.mastraBaseUrl, session.agentId, buildPromptPayload(session, content), ac.signal)) {
        for (const update of mapMastraChunkToUpdates(chunk)) {
          await conn.sessionUpdate({ sessionId: session.sessionId, update });
        }
      }
      return { stopReason: ac.signal.aborted ? 'cancelled' : 'end_turn' };
    },
    async cancel(params) { const s = store.get(params.sessionId); s?.abortController?.abort(); },
    async closeSession(params) { store.delete(params.sessionId); },
    async setSessionMode(params: SetSessionModeRequest) {
      const s = store.get(params.sessionId); if (!s) throw new Error(`Unknown session: ${params.sessionId}`);
      s.modeId = normalizeModeId(params.modeId); store.update(s);
      await emitSessionConfigUpdate(conn, s, true);
      return {};
    },
    async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
      const s = store.get(params.sessionId); if (!s) throw new Error(`Unknown session: ${params.sessionId}`);
      s.modelId = normalizeModelId(params.modelId); store.update(s);
      await emitSessionConfigUpdate(conn, s, false);
      return {};
    },
    async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
      const s = store.get(params.sessionId); if (!s) throw new Error(`Unknown session: ${params.sessionId}`);
      let modeChanged = false;
      if (typeof params.value === 'string') {
        if (params.configId === 'mode') {
          s.modeId = normalizeModeId(params.value);
          modeChanged = true;
        }
        if (params.configId === 'model') s.modelId = normalizeModelId(params.value);
        if (params.configId === 'thinking') s.thinkingOptionId = params.value;
      }
      store.update(s);
      const configOptions = buildConfigOptions(s);
      await emitSessionConfigUpdate(conn, s, modeChanged);
      return { configOptions };
    },
    async authenticate() {},
  };
}

function sessionStateResponse(session: MastraAcpSession): NewSessionResponse {
  const modeId = normalizeModeId(session.modeId);
  const modelId = normalizeModelId(session.modelId);
  return {
    sessionId: session.sessionId,
    modes: {
      availableModes: AVAILABLE_MODES.map(id=>({id,name:id})),
      currentModeId: modeId,
    },
    models: {
      availableModels: AVAILABLE_MODELS.map(modelId=>({modelId,name:modelId})),
      currentModelId: modelId,
    },
    configOptions: buildConfigOptions(session),
  };
}

async function emitSessionConfigUpdate(conn: AgentSideConnection, session: MastraAcpSession, modeChanged: boolean): Promise<void> {
  const modeId = normalizeModeId(session.modeId);
  const configOptions = buildConfigOptions(session);
  if (modeChanged) {
    await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } });
  }
  await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'config_option_update', configOptions } });
}

function buildPromptPayload(session: MastraAcpSession, content: string) {
  const modeId = normalizeModeId(session.modeId);
  const modelId = normalizeModelId(session.modelId);
  const harnessModeId = `supervisor.${modeId}`;
  return {
    messages: [{ role: 'user', content: `${formatSupervisorScopePrompt(modeId)}\n\n${content}` }],
    memory: { thread: session.threadId, resource: session.resourceId },
    model: modelId,
    requestContext: {
      acp: {
        sessionId: session.sessionId,
        cwd: session.cwd,
        modeId,
        modelId,
        thinkingOptionId: session.thinkingOptionId,
      },
      activeAgentId: 'supervisor',
      modeId,
      modelId,
      harnessMode: modeId,
      harnessModeId,
      hardnessMode: harnessModeId,
      supervisorScope: modeId,
    },
  };
}

function formatSupervisorScopePrompt(modeId: SupervisorModeId): string {
  const prompt = {
    base: 'Supervisor Lead Base:\n- Orchestrate the work pragmatically across scoping, planning, building, and verification.\n- Delegate only when a specialist can advance a bounded part of the task.\n- Keep ownership of the final answer, evidence quality, and next action.',
    scope: 'Supervisor Lead Scope:\n- Identify the smallest useful slice, non-goals, assumptions, and evidence needed.\n- Route discovery to the right specialist before committing to implementation.\n- Stop for a decision when product scope or write boundaries are unclear.',
    spec: 'Supervisor Lead Spec:\n- Convert the scoped slice into a concrete execution plan with boundaries and verification.\n- Use specialists to sharpen contracts, risks, and acceptance criteria.\n- Do not present implementation as complete while still planning.',
    exec: 'Supervisor Lead Exec:\n- Drive implementation through the appropriate specialist agents while preserving the approved boundary.\n- Keep build progress tied to concrete files, behavior, and evidence.\n- Escalate if implementation requires a new scope or architecture decision.\n- Audit the completed or claimed work before final synthesis.',
  } satisfies Record<SupervisorModeId, string>;
  return `<harness-mode id="supervisor.${modeId}" agent="supervisor" mode="${modeId}">\nAgent: Supervisor Lead\nMode: ${modeId}\n${prompt[modeId]}\n</harness-mode>`;
}
