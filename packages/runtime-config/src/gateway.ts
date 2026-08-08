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
        // The declared aliases are the catalog. See `advertisedModelIds`.
        models: this.advertisedModelIds(),
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

  /**
   * The catalog is exactly the declared proxy aliases, never what the proxy happens to advertise.
   *
   * This used to union the declared list with every id from `GET /models`. That endpoint returns
   * the raw upstream model names alongside the aliases — `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.4`,
   * `deepseek-v4-pro` — so discovery made a raw upstream id selectable, and selecting one produced
   * a model no provider entry could resolve.
   *
   * Discovery cannot be repaired by filtering, because the alias to upstream mapping is many to
   * one: the proxy distinguishes tiers by `reasoning.effort` over a shared upstream model, so
   * `code-frontier-max`, `-high`, and `-low` all resolve to `gpt-5.6-sol`. An upstream id therefore
   * carries no recoverable tier, and nothing downstream can reconstruct which alias was meant.
   *
   * `models.yaml` is the canonical declaration and `resolveAliasModelId` already rejects anything
   * absent from it, so an id discovered here but undeclared there could be selected and never
   * resolved. Publishing only the declared aliases makes the catalog agree with that rule.
   */
  private advertisedModelIds(): string[] {
    return [...this.config.models];
  }
}
