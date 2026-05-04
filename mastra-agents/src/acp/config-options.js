export const AVAILABLE_MODES = ['balanced', 'scope', 'plan', 'build', 'verify', 'research', 'analysis', 'audit', 'debug'];
export const AVAILABLE_MODELS = ['gpt-5.3-codex', 'gpt-5.3', 'gpt-5.1-mini'];
export function buildConfigOptions(session) {
    return [
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: session.modeId ?? 'balanced', options: AVAILABLE_MODES.map(v => ({ value: v, name: v })) },
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.modelId ?? AVAILABLE_MODELS[0], options: AVAILABLE_MODELS.map(v => ({ value: v, name: v })) },
        { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: session.thinkingOptionId ?? 'medium', options: ['low', 'medium', 'high'].map(v => ({ value: v, name: v[0].toUpperCase() + v.slice(1) })) },
    ];
}
