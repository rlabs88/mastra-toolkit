import { createPostgresState } from "@chat-adapter/state-pg";

import type { LinearAcpClientConfig } from "./config.js";
import type { LinearAcpClientAgentSessionWebhook, LinearAgentSessionClient } from "./types.js";

type LinearAuthConfig = Pick<
  LinearAcpClientConfig,
  | "linearApiKey"
  | "linearAccessToken"
  | "linearClientId"
  | "linearClientSecret"
  | "databaseUrl"
  | "linearOauthStatePrefix"
>;

type LinearInstallation = {
  accessToken: string;
  botUserId?: string;
  expiresAt: number | null;
  organizationId: string;
  refreshToken?: string;
};

type StateAdapter = {
  connect: () => Promise<void>;
  get: <T = unknown>(key: string) => Promise<T | null>;
  set: <T = unknown>(key: string, value: T, ttlMs?: number) => Promise<void>;
};

const installationRefreshBufferMs = 5 * 60 * 1000;
const installationKey = (organizationId: string) => `linear:installation:${organizationId}`;

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

export class ChatSdkLinearOauthAuthProvider {
  private statePromise?: Promise<StateAdapter>;

  constructor(private readonly config: LinearAuthConfig, private readonly providedState?: StateAdapter) {}

  async resolveAccessToken(organizationId: string | undefined): Promise<string> {
    if (!organizationId) {
      throw new Error("Linear organizationId is required for Chat SDK OAuth installation auth");
    }

    const state = await this.state();
    const installation = await state.get<LinearInstallation>(installationKey(organizationId));
    if (!isLinearInstallation(installation)) {
      throw new Error(`Linear OAuth installation not found for organization ${organizationId}`);
    }

    const refreshed = await this.refreshInstallationIfNeeded(installation);
    if (refreshed !== installation) {
      await state.set(installationKey(organizationId), refreshed);
    }
    return refreshed.accessToken;
  }

  private async state(): Promise<StateAdapter> {
    if (this.providedState) {
      await this.providedState.connect();
      return this.providedState;
    }
    this.statePromise ??= (async () => {
      const state = createPostgresState({
        url: this.config.databaseUrl,
        keyPrefix: this.config.linearOauthStatePrefix,
      }) as StateAdapter;
      await state.connect();
      return state;
    })();
    return this.statePromise;
  }

  private async refreshInstallationIfNeeded(installation: LinearInstallation): Promise<LinearInstallation> {
    if (!installation.refreshToken || !this.config.linearClientId || !this.config.linearClientSecret) {
      return installation;
    }
    if (installation.expiresAt !== null && installation.expiresAt > Date.now() + installationRefreshBufferMs) {
      return installation;
    }

    const response = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: installation.refreshToken,
        client_id: this.config.linearClientId,
        client_secret: this.config.linearClientSecret,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to refresh Linear OAuth installation for organization ${installation.organizationId}`);
    }

    const token = await response.json() as {
      access_token?: unknown;
      expires_in?: unknown;
      refresh_token?: unknown;
    };
    if (typeof token.access_token !== "string" || !token.access_token) {
      throw new Error(`Linear OAuth refresh did not return an access token for organization ${installation.organizationId}`);
    }

    return {
      ...installation,
      accessToken: token.access_token,
      expiresAt: typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : installation.expiresAt,
      refreshToken: typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : installation.refreshToken,
    };
  }
}

export class LinearAcpClientSdkClient implements LinearAgentSessionClient {
  private readonly oauthProvider: ChatSdkLinearOauthAuthProvider;
  private readonly clients = new Map<string, Promise<LinearAgentSessionClient>>();

  constructor(private readonly config: LinearAuthConfig) {
    this.oauthProvider = new ChatSdkLinearOauthAuthProvider(config);
  }

  async createAgentActivity(input: {
    organizationId?: string;
    agentSessionId: string;
    content: Record<string, unknown>;
    ephemeral?: boolean;
    signal?: string;
  }): Promise<unknown> {
    return (await this.client(input.organizationId)).createAgentActivity(withoutOrganizationId(input));
  }

  async updateAgentSession(id: string, input: Record<string, unknown> & { organizationId?: string }): Promise<unknown> {
    return (await this.client(input.organizationId)).updateAgentSession(id, withoutOrganizationId(input));
  }

  async createComment(input: { organizationId?: string; issueId: string; body: string; createAsUser?: string }): Promise<unknown> {
    return (await this.client(input.organizationId)).createComment(withoutOrganizationId(input));
  }

  async updateComment(id: string, input: { organizationId?: string; body: string }): Promise<unknown> {
    return (await this.client(input.organizationId)).updateComment(id, withoutOrganizationId(input));
  }

  private async client(organizationId: string | undefined): Promise<LinearAgentSessionClient> {
    const auth = await this.resolveAuth(organizationId);
    const cacheKey = auth.apiKey
      ? "api-key"
      : auth.staticAccessToken
        ? "static-access-token"
        : `oauth:${organizationId ?? "unknown"}:${auth.accessToken.slice(-8)}`;
    let clientPromise = this.clients.get(cacheKey);
    if (!clientPromise) {
      clientPromise = this.createClient(auth);
      this.clients.set(cacheKey, clientPromise);
    }
    return clientPromise;
  }

  private async resolveAuth(organizationId: string | undefined): Promise<{ apiKey?: string; accessToken?: string; staticAccessToken?: boolean }> {
    if (this.config.linearApiKey) return { apiKey: this.config.linearApiKey };
    if (this.config.linearAccessToken) return { accessToken: this.config.linearAccessToken, staticAccessToken: true };
    return { accessToken: await this.oauthProvider.resolveAccessToken(organizationId) };
  }

  private async createClient(auth: { apiKey?: string; accessToken?: string }): Promise<LinearAgentSessionClient> {
    return import("@linear/sdk").then(({ LinearClient }) => {
      return new LinearClient({
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.accessToken ? { accessToken: auth.accessToken } : {}),
      }) as unknown as LinearAgentSessionClient;
    });
  }
}

function isLinearInstallation(value: unknown): value is LinearInstallation {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { accessToken?: unknown }).accessToken === "string" &&
      typeof (value as { organizationId?: unknown }).organizationId === "string",
  );
}

function withoutOrganizationId<T extends { organizationId?: string }>(input: T): Omit<T, "organizationId"> {
  const { organizationId: _organizationId, ...rest } = input;
  return rest;
}
