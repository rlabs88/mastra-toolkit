import {
  createOpenAICompatible,
} from "@ai-sdk/openai-compatible";
import { MastraModelGateway, type GatewayLanguageModel, type ProviderConfig } from "@mastra/core/llm";

export interface ProxyGatewayConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
}

export class ProxyGateway extends MastraModelGateway {
  readonly id = "proxy";
  readonly name = "A1 OpenAI-Compatible Proxy";

  constructor(private readonly config: ProxyGatewayConfig) {
    super();
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      "a1-proxy": {
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
    if (!this.config.apiKey) {
      throw new Error("Proxy API key is missing. Inject PROXY_API_KEY with Infisical.");
    }
    return this.config.apiKey;
  }

  resolveLanguageModel(options: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): GatewayLanguageModel {
    return createOpenAICompatible({
      name: options.providerId,
      apiKey: options.apiKey,
      baseURL: this.config.baseUrl,
      ...(options.headers ? { headers: options.headers } : {}),
      supportsStructuredOutputs: true,
    }).chatModel(options.modelId);
  }

  serializeForSpan(): { id: string; name: string; baseUrl: string } {
    return { id: this.id, name: this.name, baseUrl: this.config.baseUrl };
  }

  private async fetchModelIds(): Promise<string[]> {
    if (!this.config.apiKey) return [...this.config.models];

    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      });
      if (!response.ok) return [...this.config.models];

      const body = await response.json() as { data?: Array<{ id?: unknown }> };
      const discovered = (body.data ?? []).flatMap(model => (
        typeof model.id === "string" ? [model.id] : []
      ));
      return [...new Set([...this.config.models, ...discovered])];
    } catch {
      return [...this.config.models];
    }
  }
}
