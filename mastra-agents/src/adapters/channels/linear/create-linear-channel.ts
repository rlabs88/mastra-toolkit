import { createLinearAdapter } from "@chat-adapter/linear";

import type { AgentChannelsConfig } from "../types.js";
import { getEnv } from "../types.js";

export function getLinearMode(config: AgentChannelsConfig = {}) {
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

export function createLinearChannel(config: AgentChannelsConfig = {}) {
  return createLinearAdapter(buildLinearAdapterConfig(config));
}
