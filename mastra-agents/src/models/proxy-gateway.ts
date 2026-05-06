import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { MastraModelGateway, type GatewayLanguageModel, type ProviderConfig } from "@mastra/core/llm";

// Hosted CLIProxyAPI-compatible endpoint. Upstream docs/reference:
// https://github.com/router-for-me/CLIProxyAPI
// https://deepwiki.com/router-for-me/CLIProxyAPI
const defaultProxyBaseUrl = "https://aa.renaissancelab.org/v1";
const fallbackModels = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
];

export class ProxyGateway extends MastraModelGateway {
  readonly id = "proxy";
  readonly name = "OpenAI-Compatible Proxy";

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      openai: {
        name: "Proxy OpenAI-compatible",
        models: await this.fetchModelIds(),
        apiKeyEnvVar: ["PROXY_API_KEY", "CLI_PROXY_API_KEY", "CLI_PROXY_STACK_API_KEY"],
        gateway: this.id,
        url: this.baseUrl(),
        docUrl: "https://help.router-for.me/configuration/thinking",
      },
    };
  }

  buildUrl(): string {
    return this.baseUrl();
  }

  async getApiKey(): Promise<string> {
    const apiKey = proxyApiKey();
    if (!apiKey) {
      throw new Error("Proxy API key is missing. Set PROXY_API_KEY.");
    }
    return apiKey;
  }

  resolveLanguageModel({
    modelId,
    providerId,
    apiKey,
    headers,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): GatewayLanguageModel {
    return createOpenAICompatible({
      name: providerId,
      apiKey,
      baseURL: this.baseUrl(),
      headers,
      supportsStructuredOutputs: true,
    }).chatModel(modelId);
  }

  serializeForSpan() {
    return {
      id: this.id,
      name: this.name,
      baseUrl: this.baseUrl(),
    };
  }

  private baseUrl(): string {
    return (
      optionalEnv("PROXY_BASE_URL") ??
      optionalEnv("CLI_PROXY_BASE_URL") ??
      defaultProxyBaseUrl
    ).replace(/\/+$/, "");
  }

  private async fetchModelIds(): Promise<string[]> {
    const apiKey = proxyApiKey();
    if (!apiKey) return fallbackModels;

    try {
      const response = await fetch(`${this.baseUrl()}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (!response.ok) return fallbackModels;
      const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown; model?: unknown }> };
      const models = (body.data ?? [])
        .map((model) => stringValue(model.id) ?? stringValue(model.name) ?? stringValue(model.model))
        .filter((model): model is string => Boolean(model));
      return models.length > 0 ? models : fallbackModels;
    } catch {
      return fallbackModels;
    }
  }
}

function proxyApiKey(): string | undefined {
  return (
    optionalEnv("PROXY_API_KEY") ??
    optionalEnv("CLI_PROXY_API_KEY") ??
    optionalEnv("CLI_PROXY_STACK_API_KEY")
  );
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
