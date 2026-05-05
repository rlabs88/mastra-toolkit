export function resolveThinkingProviderOptions({ modelId, thinkingLevel, }) {
    const normalizedLevel = normalizeThinkingLevel(thinkingLevel);
    if (!thinkingLevel?.trim()) {
        return {
            metadata: {
                status: 'omitted',
                reason: 'No ACP thinking level was selected',
            },
        };
    }
    if (!normalizedLevel) {
        return {
            metadata: {
                requestedLevel: thinkingLevel,
                status: 'invalid_level',
                reason: `Unknown ACP thinking level ${thinkingLevel}`,
            },
        };
    }
    const provider = providerFromModelId(modelId);
    if (provider === 'openai' && isOpenAiReasoningModel(modelId)) {
        return {
            providerOptions: {
                openai: {
                    reasoningEffort: normalizedLevel,
                },
            },
            metadata: {
                requestedLevel: normalizedLevel,
                status: 'applied',
                provider,
                providerOptionPath: 'providerOptions.openai.reasoningEffort',
                providerOptionValue: normalizedLevel,
            },
        };
    }
    return {
        metadata: {
            requestedLevel: normalizedLevel,
            status: 'unsupported_provider',
            provider,
            reason: `No ACP thinking mapping is defined for provider ${provider}`,
        },
    };
}
function normalizeThinkingLevel(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high')
        return normalized;
    return undefined;
}
function providerFromModelId(modelId) {
    const normalized = modelId.trim().toLowerCase();
    if (normalized.includes('/'))
        return normalized.split('/')[0] || 'unknown';
    const modelName = modelNameFromModelId(normalized);
    if (modelName.startsWith('gpt-') || /^o\d/.test(modelName))
        return 'openai';
    if (modelName.startsWith('claude-'))
        return 'anthropic';
    if (modelName.startsWith('gemini-') || modelName.startsWith('gemma-'))
        return 'google';
    if (modelName.startsWith('grok-'))
        return 'xai';
    return 'unknown';
}
function isOpenAiReasoningModel(modelId) {
    const modelName = modelNameFromModelId(modelId.trim().toLowerCase());
    return (modelName.startsWith('gpt-5') ||
        /^o\d/.test(modelName));
}
function modelNameFromModelId(modelId) {
    return modelId.includes('/') ? modelId.split('/').at(-1) ?? modelId : modelId;
}
