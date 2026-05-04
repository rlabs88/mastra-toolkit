import { buildConfigOptions, AVAILABLE_MODELS, AVAILABLE_MODES } from './config-options.js';
import { mapMastraChunkToUpdates } from './event-mapper.js';
import { streamMastraAgent } from './mastra-stream.js';
import { MastraAcpSessionStore } from './session-store.js';
import { getSlashCommands } from './slash-commands.js';
export function createMastraAcpAgentHandler(conn, options) {
    const store = new MastraAcpSessionStore();
    return {
        async initialize(_params) {
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
        async newSession(_params) {
            const session = store.create({ agentId: options.agentId, cwd: options.cwd, resourceId: options.defaultResourceId, threadId: options.defaultThreadId });
            await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: getSlashCommands() } });
            return { sessionId: session.sessionId, modes: { availableModes: AVAILABLE_MODES.map(id => ({ id, name: id })), currentModeId: session.modeId ?? 'balanced' }, models: { availableModels: AVAILABLE_MODELS.map(modelId => ({ modelId, name: modelId })), currentModelId: session.modelId ?? AVAILABLE_MODELS[0] }, configOptions: buildConfigOptions(session) };
        },
        async prompt(params) {
            const session = store.get(params.sessionId);
            if (!session)
                throw new Error(`Unknown session: ${params.sessionId}`);
            const last = params.prompt.findLast((b) => b.type === 'text' && typeof b.text === 'string');
            const content = (last && 'text' in last) ? last.text : '';
            const ac = new AbortController();
            session.abortController = ac;
            store.update(session);
            for await (const chunk of streamMastraAgent(options.mastraBaseUrl, session.agentId, { messages: [{ role: 'user', content }], memory: { thread: session.threadId, resource: session.resourceId }, requestContext: { acp: { sessionId: session.sessionId, cwd: session.cwd, modeId: session.modeId, modelId: session.modelId, thinkingOptionId: session.thinkingOptionId }, modeId: session.modeId, harnessMode: session.modeId } }, ac.signal)) {
                for (const update of mapMastraChunkToUpdates(chunk)) {
                    await conn.sessionUpdate({ sessionId: session.sessionId, update });
                }
            }
            return { stopReason: ac.signal.aborted ? 'cancelled' : 'end_turn' };
        },
        async cancel(params) { const s = store.get(params.sessionId); s?.abortController?.abort(); },
        async closeSession(params) { store.delete(params.sessionId); },
        async setSessionMode(params) {
            const s = store.get(params.sessionId);
            if (!s)
                throw new Error(`Unknown session: ${params.sessionId}`);
            s.modeId = params.modeId;
            store.update(s);
            await conn.sessionUpdate({ sessionId: s.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: s.modeId ?? 'balanced' } });
            await conn.sessionUpdate({ sessionId: s.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: buildConfigOptions(s) } });
            return {};
        },
        async unstable_setSessionModel(params) {
            const s = store.get(params.sessionId);
            if (!s)
                throw new Error(`Unknown session: ${params.sessionId}`);
            s.modelId = params.modelId;
            store.update(s);
            await conn.sessionUpdate({ sessionId: s.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: buildConfigOptions(s) } });
            return {};
        },
        async setSessionConfigOption(params) {
            const s = store.get(params.sessionId);
            if (!s)
                throw new Error(`Unknown session: ${params.sessionId}`);
            if (typeof params.value === 'string') {
                if (params.configId === 'mode')
                    s.modeId = params.value;
                if (params.configId === 'model')
                    s.modelId = params.value;
                if (params.configId === 'thinking')
                    s.thinkingOptionId = params.value;
            }
            store.update(s);
            const configOptions = buildConfigOptions(s);
            await conn.sessionUpdate({ sessionId: s.sessionId, update: { sessionUpdate: 'config_option_update', configOptions } });
            return { configOptions };
        },
        async authenticate() { },
    };
}
