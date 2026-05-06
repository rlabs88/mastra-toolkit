import type { LinearAcpClientConfig } from "./config.js";
import type { LinearAcpClientAgentSessionWebhook, LinearAgentSessionClient } from "./types.js";

export interface LinearAcpClientWebhookVerifier {
  parse(rawBody: Buffer, signature: string, timestamp?: string | null): Promise<LinearAcpClientAgentSessionWebhook>;
}

export class LinearSdkWebhookVerifier implements LinearAcpClientWebhookVerifier {
  private clientPromise?: Promise<{ parseVerifiedPayload: (rawBody: Buffer, signature: string, timestamp?: string | null) => unknown }>;

  constructor(private readonly secret: string) {}

  async parse(rawBody: Buffer, signature: string, timestamp?: string | null): Promise<LinearAcpClientAgentSessionWebhook> {
    const client = await this.client();
    return client.parseVerifiedPayload(rawBody, signature, timestamp) as LinearAcpClientAgentSessionWebhook;
  }

  private async client() {
    this.clientPromise ??= import("@linear/sdk/webhooks").then(({ LinearWebhookClient }) => {
      const instance = new LinearWebhookClient(this.secret);
      return instance as unknown as { parseVerifiedPayload: (rawBody: Buffer, signature: string, timestamp?: string | null) => unknown };
    });
    return this.clientPromise;
  }
}

export class LinearAcpClientSdkClient implements LinearAgentSessionClient {
  private clientPromise?: Promise<LinearAgentSessionClient>;

  constructor(private readonly config: Pick<LinearAcpClientConfig, "linearApiKey" | "linearAccessToken">) {}

  async createAgentActivity(input: {
    agentSessionId: string;
    content: Record<string, unknown>;
    ephemeral?: boolean;
    signal?: string;
  }): Promise<unknown> {
    return (await this.client()).createAgentActivity(input);
  }

  async updateAgentSession(id: string, input: Record<string, unknown>): Promise<unknown> {
    return (await this.client()).updateAgentSession(id, input);
  }

  async createComment(input: { issueId: string; body: string; createAsUser?: string }): Promise<unknown> {
    return (await this.client()).createComment(input);
  }

  async updateComment(id: string, input: { body: string }): Promise<unknown> {
    return (await this.client()).updateComment(id, input);
  }

  private async client(): Promise<LinearAgentSessionClient> {
    this.clientPromise ??= import("@linear/sdk").then(({ LinearClient }) => {
      return new LinearClient({
        ...(this.config.linearApiKey ? { apiKey: this.config.linearApiKey } : {}),
        ...(this.config.linearAccessToken ? { accessToken: this.config.linearAccessToken } : {}),
      }) as unknown as LinearAgentSessionClient;
    });
    return this.clientPromise;
  }
}
