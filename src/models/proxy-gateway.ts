import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { MastraModelGateway, type GatewayLanguageModel, type ProviderConfig } from "@mastra/core/llm";

const FALLBACK_MODELS = ["gpt-5.6-luna", "gpt-5.6", "gpt-5.5"];

export class ProxyGateway extends MastraModelGateway {
  readonly id = "proxy";
  readonly name = "A1 OpenAI-Compatible Proxy";

  constructor(private readonly config: { readonly baseUrl: string; readonly apiKey?: string }) {
    super();
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      openai: {
        name: "A1 OpenAI-compatible",
        models: await this.fetchModelIds(),
        apiKeyEnvVar: ["PROXY_API_KEY", "CLI_PROXY_API_KEY"],
        gateway: this.id,
        url: this.config.baseUrl,
      },
    };
  }

  buildUrl(): string {
    return this.config.baseUrl;
  }

  async getApiKey(): Promise<string> {
    if (!this.config.apiKey) throw new Error("Proxy API key is missing. Inject PROXY_API_KEY with Infisical.");
    return this.config.apiKey;
  }

  resolveLanguageModel({ modelId, providerId, apiKey, headers }: { modelId: string; providerId: string; apiKey: string; headers?: Record<string, string> }): GatewayLanguageModel {
    return createOpenAICompatible({
      name: providerId,
      apiKey,
      baseURL: this.config.baseUrl,
      ...(headers ? { headers } : {}),
      supportsStructuredOutputs: true,
    }).chatModel(modelId);
  }

  serializeForSpan(): { id: string; name: string; baseUrl: string } {
    return { id: this.id, name: this.name, baseUrl: this.config.baseUrl };
  }

  private async fetchModelIds(): Promise<string[]> {
    if (!this.config.apiKey) return FALLBACK_MODELS;
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, { headers: { authorization: `Bearer ${this.config.apiKey}` } });
      if (!response.ok) return FALLBACK_MODELS;
      const body = await response.json() as { data?: Array<{ id?: unknown }> };
      const models = (body.data ?? []).flatMap(model => typeof model.id === "string" ? [model.id] : []);
      return models.length > 0 ? models : FALLBACK_MODELS;
    } catch {
      return FALLBACK_MODELS;
    }
  }
}
