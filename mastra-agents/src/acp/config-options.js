export const SUPERVISOR_MODE_IDS = ['base', 'scope', 'spec', 'exec'];
export const DEFAULT_ACP_MODE_ID = 'base';
export const DEFAULT_ACP_MODEL_ID = process.env.MASTRA_SUPERVISOR_MODEL?.trim() ||
    process.env.MASTRA_AGENT_MODEL?.trim() ||
    process.env.MASTRA_SUBAGENT_MODEL?.trim() ||
    process.env.MASTRA_MODEL?.trim() ||
    'minimax-coding-plan/MiniMax-M2.7';
export const AVAILABLE_MODES = [...SUPERVISOR_MODE_IDS];
export const AVAILABLE_MODELS = [
    DEFAULT_ACP_MODEL_ID,
    'gpt-5.3-codex',
    'gpt-5.3',
    'gpt-5.1-mini',
].filter((modelId, index, models) => modelId && models.indexOf(modelId) === index);
const modeAliases = new Map([
    ['base', 'base'],
    ['balance', 'base'],
    ['balanced', 'base'],
    ['scope', 'scope'],
    ['spec', 'spec'],
    ['plan', 'spec'],
    ['exec', 'exec'],
    ['execution', 'exec'],
    ['build', 'exec'],
    ['verify', 'exec'],
]);
export function normalizeModeId(value) {
    if (typeof value !== 'string')
        return DEFAULT_ACP_MODE_ID;
    return modeAliases.get(value.trim().toLowerCase().replace(/_/g, '-')) ?? DEFAULT_ACP_MODE_ID;
}
export function normalizeModelId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_ACP_MODEL_ID;
}
export function buildConfigOptions(session) {
    const modeId = normalizeModeId(session.modeId);
    const modelId = normalizeModelId(session.modelId);
    return [
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: modeId, options: AVAILABLE_MODES.map(v => ({ value: v, name: v })) },
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelId, options: AVAILABLE_MODELS.map(v => ({ value: v, name: v })) },
        { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: session.thinkingOptionId ?? 'medium', options: ['low', 'medium', 'high'].map(v => ({ value: v, name: v[0].toUpperCase() + v.slice(1) })) },
    ];
}
