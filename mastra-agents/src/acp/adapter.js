import { buildConfigOptions, loadAcpRuntimeConfig, modeDefinitionForSession, modelOptionsForSession, normalizeModeId, normalizeModelId } from './config-options.js';
import { mapMastraChunkToUpdates } from './event-mapper.js';
import { streamMastraAgent } from './mastra-stream.js';
import { MastraAcpSessionStore } from './session-store.js';
import { getSlashCommands } from './slash-commands.js';
import { resolveThinkingProviderOptions } from './thinking-options.js';
export function createMastraAcpAgentHandler(conn, options) {
    const store = new MastraAcpSessionStore();
    const runtimeConfig = () => loadAcpRuntimeConfig(options.agentId, options.mastraBaseUrl);
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
            const config = await runtimeConfig();
            const session = store.create({
                agentId: options.agentId,
                cwd: options.cwd,
                resourceId: options.defaultResourceId,
                threadId: options.defaultThreadId,
                defaultModeId: config.defaultModeId,
                defaultModelId: config.defaultModelId,
            });
            await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: getSlashCommands() } });
            return sessionStateResponse(session, config);
        },
        async prompt(params) {
            const config = await runtimeConfig();
            const session = store.get(params.sessionId);
            if (!session)
                throw new Error(`Unknown session: ${params.sessionId}`);
            const last = params.prompt.findLast((b) => b.type === 'text' && typeof b.text === 'string');
            const content = (last && 'text' in last) ? last.text : '';
            const ac = new AbortController();
            session.abortController = ac;
            store.update(session);
            for await (const chunk of streamMastraAgent(options.mastraBaseUrl, session.agentId, buildPromptPayload(session, content, config), ac.signal)) {
                for (const update of mapMastraChunkToUpdates(chunk)) {
                    await conn.sessionUpdate({ sessionId: session.sessionId, update });
                }
            }
            return { stopReason: ac.signal.aborted ? 'cancelled' : 'end_turn' };
        },
        async cancel(params) { const s = store.get(params.sessionId); s?.abortController?.abort(); },
        async closeSession(params) { store.delete(params.sessionId); },
        async setSessionMode(params) {
            const config = await runtimeConfig();
            const s = store.get(params.sessionId);
            if (!s)
                throw new Error(`Unknown session: ${params.sessionId}`);
            s.modeId = normalizeModeId(params.modeId, config);
            store.update(s);
            await emitSessionConfigUpdate(conn, s, config, true);
            return {};
        },
        async unstable_setSessionModel(params) {
            const config = await runtimeConfig();
            const s = store.get(params.sessionId);
            if (!s)
                throw new Error(`Unknown session: ${params.sessionId}`);
            s.modelId = normalizeModelId(params.modelId, config);
            store.update(s);
            await emitSessionConfigUpdate(conn, s, config, false);
            return {};
        },
        async setSessionConfigOption(params) {
            const config = await runtimeConfig();
            const s = store.get(params.sessionId);
            if (!s)
                throw new Error(`Unknown session: ${params.sessionId}`);
            let modeChanged = false;
            if (typeof params.value === 'string') {
                if (params.configId === 'mode') {
                    s.modeId = normalizeModeId(params.value, config);
                    modeChanged = true;
                }
                if (params.configId === 'model')
                    s.modelId = normalizeModelId(params.value, config);
                if (params.configId === 'thinking')
                    s.thinkingOptionId = params.value;
            }
            store.update(s);
            const configOptions = buildConfigOptions(s, config);
            await emitSessionConfigUpdate(conn, s, config, modeChanged);
            return { configOptions };
        },
        async authenticate() { },
    };
}
function sessionStateResponse(session, config) {
    const modeId = normalizeModeId(session.modeId, config);
    const modelId = normalizeModelId(session.modelId, config);
    return {
        sessionId: session.sessionId,
        modes: {
            availableModes: config.modes.map(mode => ({ id: mode.id, name: mode.name })),
            currentModeId: modeId,
        },
        models: {
            availableModels: modelOptionsForSession(session, config).map(modelId => ({ modelId, name: modelId })),
            currentModelId: modelId,
        },
        configOptions: buildConfigOptions(session, config),
    };
}
async function emitSessionConfigUpdate(conn, session, config, modeChanged) {
    const modeId = normalizeModeId(session.modeId, config);
    const configOptions = buildConfigOptions(session, config);
    if (modeChanged) {
        await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } });
    }
    await conn.sessionUpdate({ sessionId: session.sessionId, update: { sessionUpdate: 'config_option_update', configOptions } });
}
function buildPromptPayload(session, content, config) {
    const mode = modeDefinitionForSession(session, config);
    const modeId = mode.id;
    const modelId = normalizeModelId(session.modelId, config);
    const thinkingOptions = resolveThinkingProviderOptions({ modelId, thinkingLevel: session.thinkingOptionId });
    return {
        messages: [{ role: 'user', content: `${mode.prompt}\n\n${content}` }],
        memory: { thread: session.threadId, resource: session.resourceId },
        model: modelId,
        ...(thinkingOptions.providerOptions ? { providerOptions: thinkingOptions.providerOptions } : {}),
        requestContext: {
            acp: {
                sessionId: session.sessionId,
                cwd: session.cwd,
                modeId,
                modelId,
                thinkingOptionId: session.thinkingOptionId,
                thinking: thinkingOptions.metadata,
            },
            activeAgentId: mode.agentId,
            modeId,
            modelId,
            harnessMode: mode.harnessMode,
            harnessModeId: mode.harnessModeId,
            hardnessMode: mode.harnessModeId,
            ...(mode.agentId === 'supervisor' ? { supervisorScope: mode.harnessMode } : { orchestratorMode: mode.harnessMode }),
        },
    };
}
