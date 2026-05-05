export type ThinkingLevel = 'low' | 'medium' | 'high';
export type ThinkingMetadata = {
    requestedLevel: ThinkingLevel;
    status: 'applied';
    provider: string;
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
    providerOptions?: Record<string, unknown>;
    metadata: ThinkingMetadata;
};
export declare function resolveThinkingProviderOptions({ modelId, thinkingLevel, }: {
    modelId: string;
    thinkingLevel?: string;
}): ThinkingProviderOptionsResult;
