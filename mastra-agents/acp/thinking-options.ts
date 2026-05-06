export type ThinkingLevel = 'low' | 'medium' | 'high';

export type ThinkingMetadata =
  | {
      requestedLevel: ThinkingLevel;
      status: 'applied';
      provider: string;
      strategy: 'provider_options' | 'model_name_suffix';
      providerOptionPath: string;
      providerOptionValue: unknown;
    }
  | {
      requestedLevel?: string;
      status: 'omitted' | 'invalid_level';
      reason: string;
    }
  | {
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

type ThinkingLevelAdapter = {
  provider: string;
  strategy: 'provider_options' | 'model_name_suffix';
  supportsModel: (modelId: string) => boolean;
};

const thinkingLevelAdapters: ThinkingLevelAdapter[] = [
  {
    provider: 'openai',
    strategy: 'provider_options',
    supportsModel: isOpenAiReasoningModel,
  },
  {
    provider: 'proxy',
    strategy: 'model_name_suffix',
    supportsModel: isOpenAiReasoningModel,
  },
];

export function resolveThinkingProviderOptions({
  modelId,
  thinkingLevel,
}: {
  modelId: string;
  thinkingLevel?: string;
}): ThinkingProviderOptionsResult {
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
  const adapter = thinkingLevelAdapters.find((candidate) => candidate.provider === provider && candidate.supportsModel(modelId));
  if (adapter?.strategy === 'provider_options') {
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
        strategy: adapter.strategy,
        providerOptionPath: 'providerOptions.openai.reasoningEffort',
        providerOptionValue: normalizedLevel,
      },
    };
  }
  if (adapter?.strategy === 'model_name_suffix') {
    const effectiveModelId = appendThinkingLevelSuffix(modelId, normalizedLevel);
    return {
      modelId: effectiveModelId,
      metadata: {
        requestedLevel: normalizedLevel,
        status: 'applied',
        provider,
        strategy: adapter.strategy,
        providerOptionPath: 'model',
        providerOptionValue: effectiveModelId,
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

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized;
  return undefined;
}

function providerFromModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.includes('/')) return normalized.split('/')[0] || 'unknown';
  const modelName = modelNameFromModelId(normalized);
  if (modelName.startsWith('gpt-') || /^o\d/.test(modelName)) return 'openai';
  if (modelName.startsWith('claude-')) return 'anthropic';
  if (modelName.startsWith('gemini-') || modelName.startsWith('gemma-')) return 'google';
  if (modelName.startsWith('grok-')) return 'xai';
  return 'unknown';
}

function isOpenAiReasoningModel(modelId: string): boolean {
  const modelName = stripThinkingLevelSuffix(modelNameFromModelId(modelId.trim().toLowerCase()));
  return (
    modelName.startsWith('gpt-5') ||
    /^o\d/.test(modelName)
  );
}

function modelNameFromModelId(modelId: string): string {
  return modelId.includes('/') ? modelId.split('/').at(-1) ?? modelId : modelId;
}

function appendThinkingLevelSuffix(modelId: string, thinkingLevel: ThinkingLevel): string {
  return `${stripThinkingLevelSuffix(modelId.trim())}(${thinkingLevel})`;
}

function stripThinkingLevelSuffix(modelId: string): string {
  return modelId.replace(/\([^()/]*\)\s*$/, '');
}
