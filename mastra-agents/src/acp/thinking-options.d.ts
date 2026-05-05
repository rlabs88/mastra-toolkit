export type ThinkingLevel = 'low' | 'medium' | 'high';
export type ThinkingMetadata = {
    requestedLevel: ThinkingLevel;
    status: 'applied';
    provider: string;
    strategy: 'provider_options' | 'model_name_suffix';
    providerOptionPath: string;
    providerOptionValue: unknown;
} | {
    requestedLevel?: string;
    status: 'omitted' | 'invalid_level';
    reason: string;
} | {
    requestedLevel: ThinkingLevel;
    status: 'unsupported_provider';
    provider: string;
    reason: string;
};
export type ThinkingProviderOptionsResult = {
    modelId?: string;
    providerOptions?: Record<string, unknown>;
    metadata: ThinkingMetadata;
};
export declare function resolveThinkingProviderOptions({ modelId, thinkingLevel, }: {
    modelId: string;
    thinkingLevel?: string;
}): ThinkingProviderOptionsResult;
