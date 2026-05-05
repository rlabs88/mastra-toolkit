import { createLinearAdapter } from "@chat-adapter/linear";
import { createGitHubAdapter } from "@chat-adapter/github";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";

export const publicChannelAgentId = "supervisor-agent";
export const publicChannelAgentIds = ["supervisor-agent"] as const;
export const channelPlatforms = ["slack", "github", "linear"] as const;
const defaultPostgresUrl = "postgresql://mastra:mastra@mastra-postgres:5432/mastra";

export type ChannelPlatform = (typeof channelPlatforms)[number];

export interface AgentChannelsConfig {
  envPrefix?: string;
  slack?: {
    enableKey?: string;
    botTokenKey?: string;
    signingSecretKey?: string;
    clientIdKey?: string;
    clientSecretKey?: string;
  };
  github?: {
    enableKey?: string;
    webhookSecretKey?: string;
    tokenKey?: string;
    appIdKey?: string;
    privateKeyKey?: string;
  };
  linear?: {
    webhookSecretKey?: string;
    apiKeyKey?: string;
    accessTokenKey?: string;
    clientIdKey?: string;
    clientSecretKey?: string;
    encryptionKeyKey?: string;
    clientCredentialsIdKey?: string;
    clientCredentialsSecretKey?: string;
    oauthScopesKey?: string;
    modeKey?: string;
    fallbackModeKey?: string;
  };
}

export interface ChannelStatus {
  enabled: boolean;
  reason?: string;
  mode?: string;
}

export type ChannelStatusMap = Record<ChannelPlatform, ChannelStatus>;

function getEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function getLinearMode(config: AgentChannelsConfig = {}) {
  const linearMode =
    getEnv(config.linear?.modeKey ?? "LINEAR_CHANNEL_MODE") ??
    getEnv(config.linear?.fallbackModeKey ?? "LINEAR_MODE");
  return linearMode === "agent-sessions" ? "agent-sessions" : "comments";
}

function getLinearOAuthScopes(config: AgentChannelsConfig = {}) {
  return (
    getEnv(config.linear?.oauthScopesKey ?? "LINEAR_OAUTH_SCOPES") ??
    "read,write,comments:create,issues:create,app:mentionable,app:assignable"
  )
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function getLinearClientCredentialsScopes(config: AgentChannelsConfig = {}) {
  return (
    getEnv("LINEAR_CLIENT_CREDENTIALS_SCOPES") ??
    getLinearOAuthScopes(config).join(",")
  )
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function buildLinearAdapterConfig(config: AgentChannelsConfig = {}) {
  const mode = getLinearMode(config);
  const clientId = getEnv(config.linear?.clientIdKey ?? "LINEAR_CLIENT_ID");
  const clientSecret = getEnv(config.linear?.clientSecretKey ?? "LINEAR_CLIENT_SECRET");
  const clientCredentialsClientId = getEnv(
    config.linear?.clientCredentialsIdKey ?? "LINEAR_CLIENT_CREDENTIALS_CLIENT_ID",
  );
  const clientCredentialsClientSecret = getEnv(
    config.linear?.clientCredentialsSecretKey ?? "LINEAR_CLIENT_CREDENTIALS_CLIENT_SECRET",
  );

  if (clientId && clientSecret) {
    return {
      clientId,
      clientSecret,
      mode,
    };
  }

  if (clientCredentialsClientId && clientCredentialsClientSecret) {
    return {
      clientCredentials: {
        clientId: clientCredentialsClientId,
        clientSecret: clientCredentialsClientSecret,
        scopes: getLinearClientCredentialsScopes(config),
      },
      mode,
    };
  }

  return { mode };
}

export function resolveAgentChannelStatus(config: AgentChannelsConfig = {}): ChannelStatusMap {
  const slackEnable = getEnv(config.slack?.enableKey ?? "ENABLE_SLACK_CHANNEL");
  const slackSigningSecret = getEnv(config.slack?.signingSecretKey ?? "SLACK_SIGNING_SECRET");
  const slackAuthConfigured = Boolean(
    getEnv(config.slack?.botTokenKey ?? "SLACK_BOT_TOKEN") ||
      (getEnv(config.slack?.clientIdKey ?? "SLACK_CLIENT_ID") &&
        getEnv(config.slack?.clientSecretKey ?? "SLACK_CLIENT_SECRET")),
  );

  const ghEnable = getEnv(config.github?.enableKey ?? "ENABLE_GITHUB_CHANNEL");
  const ghWebhookSecret = getEnv(config.github?.webhookSecretKey ?? "GITHUB_WEBHOOK_SECRET");
  const ghAuthConfigured = Boolean(
    getEnv(config.github?.tokenKey ?? "GITHUB_TOKEN") ||
      (getEnv(config.github?.appIdKey ?? "GITHUB_APP_ID") &&
        getEnv(config.github?.privateKeyKey ?? "GITHUB_PRIVATE_KEY")),
  );

  const linearWebhookSecret = getEnv(config.linear?.webhookSecretKey ?? "LINEAR_WEBHOOK_SECRET");
  const linearClientId = getEnv(config.linear?.clientIdKey ?? "LINEAR_CLIENT_ID");
  const linearClientSecret = getEnv(config.linear?.clientSecretKey ?? "LINEAR_CLIENT_SECRET");
  const linearAuthConfigured = Boolean(
    (linearClientId && linearClientSecret) ||
      getEnv(config.linear?.accessTokenKey ?? "LINEAR_ACCESS_TOKEN") ||
      (getEnv(config.linear?.clientCredentialsIdKey ?? "LINEAR_CLIENT_CREDENTIALS_CLIENT_ID") &&
        getEnv(config.linear?.clientCredentialsSecretKey ?? "LINEAR_CLIENT_CREDENTIALS_CLIENT_SECRET")) ||
      getEnv(config.linear?.apiKeyKey ?? "LINEAR_API_KEY"),
  );

  return {
    slack:
      slackEnable !== "true"
        ? { enabled: false, reason: "ENABLE_SLACK_CHANNEL is not true" }
        : !slackSigningSecret
          ? { enabled: false, reason: "SLACK_SIGNING_SECRET is not set" }
          : !slackAuthConfigured
            ? { enabled: false, reason: "Slack auth is not configured" }
            : { enabled: true, mode: "webhook" },
    github:
      ghEnable !== "true"
        ? { enabled: false, reason: "ENABLE_GITHUB_CHANNEL is not true" }
        : !ghWebhookSecret
          ? { enabled: false, reason: "GITHUB_WEBHOOK_SECRET is not set" }
          : !ghAuthConfigured
            ? { enabled: false, reason: "GitHub auth is not configured" }
            : { enabled: true, mode: "webhook" },
    linear:
      !linearWebhookSecret
        ? { enabled: false, reason: "LINEAR_WEBHOOK_SECRET is not set" }
        : !linearAuthConfigured
          ? { enabled: false, reason: "Linear auth is not configured" }
          : { enabled: true, mode: getLinearMode(config) },
  };
}

export function listEnabledChannelPlatforms(config: AgentChannelsConfig = {}) {
  const status = resolveAgentChannelStatus(config);
  return channelPlatforms.filter((platform) => status[platform].enabled);
}

export function expectedChannelWebhookRoutes(agentId = publicChannelAgentId, config: AgentChannelsConfig = {}) {
  return listEnabledChannelPlatforms(config).map((platform) => ({
    method: "POST",
    path: `/api/agents/${agentId}/channels/${platform}/webhook`,
    platform,
  }));
}

export function listConfiguredChannelWebhookRoutes(routes: Array<{ method?: string; path?: string }> = []) {
  return routes
    .filter((route) => route.method === "POST" && route.path?.includes("/channels/") && route.path.endsWith("/webhook"))
    .map((route) => ({ method: route.method ?? "POST", path: route.path ?? "" }));
}

export function channelWebhookApiRoutesForAgents(
  agents: Record<string, { getChannels?: () => { getWebhookRoutes?: () => unknown[] } | null }>,
) {
  const seen = new Set<string>();
  const routes: unknown[] = [];

  for (const agent of Object.values(agents)) {
    for (const route of agent.getChannels?.()?.getWebhookRoutes?.() ?? []) {
      const routeKey = routeKeyFor(route);
      if (seen.has(routeKey)) continue;
      seen.add(routeKey);
      routes.push(markMastraInternalRoute(route));
    }
  }

  return routes;
}

function markMastraInternalRoute(route: unknown) {
  if (!route || typeof route !== "object") return route;
  return {
    ...route,
    _mastraInternal: true,
  };
}

function routeKeyFor(route: unknown) {
  if (!route || typeof route !== "object") return String(route);
  const candidate = route as { method?: unknown; path?: unknown };
  return `${String(candidate.method ?? "")} ${String(candidate.path ?? "")}`;
}

export function buildAgentChannels(config: AgentChannelsConfig = {}) {
  const adapters: Record<string, unknown> = {};
  const status = resolveAgentChannelStatus(config);

  if (status.slack.enabled) {
    adapters.slack = createSlackAdapter();
  }

  if (status.github.enabled) {
    adapters.github = createGitHubAdapter();
  }

  if (status.linear.enabled) {
    adapters.linear = createLinearAdapter(buildLinearAdapterConfig(config));
  }

  return Object.keys(adapters).length > 0
    ? {
      adapters,
      state: createPostgresState({
        url: process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? defaultPostgresUrl,
        keyPrefix: process.env.MASTRA_CHANNEL_STATE_PREFIX ?? "mastra-agents-channels",
      }),
    }
    : undefined;
}
