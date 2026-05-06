import { createLinearAdapter } from "@chat-adapter/linear";
import type { LinearAdapterMode } from "@chat-adapter/linear";
import type { ChannelAdapterConfig } from "@mastra/core/channels";

import type { AgentChannelsConfig } from "../types.js";
import { getEnv } from "../types.js";
import { formatLinearError } from "./format-linear-error.js";
import { formatLinearToolCall } from "./format-linear-tool-call.js";

type LinearMessage = {
  text?: string;
};

type LinearAdapterWithParseMessage = ReturnType<typeof createLinearAdapter> & {
  parseMessage?: (raw: unknown) => LinearMessage;
};

export function getLinearMode(config: AgentChannelsConfig = {}): LinearAdapterMode {
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

export function sanitizeLinearMessageText(text: string) {
  return text
    .replace(/<user\b[^>]*>(.*?)<\/user>/gis, (_match, name: string) => `@${name.trim()}`)
    .replace(/<\/?[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function withSanitizedLinearMessages(adapter: ReturnType<typeof createLinearAdapter>) {
  const linearAdapter = adapter as LinearAdapterWithParseMessage;
  const parseMessage = linearAdapter.parseMessage?.bind(linearAdapter);
  if (!parseMessage) return adapter;

  linearAdapter.parseMessage = (raw: unknown) => {
    const message = parseMessage(raw);
    if (typeof message.text === "string") {
      message.text = sanitizeLinearMessageText(message.text);
    }
    return message;
  };

  return adapter;
}

export function createLinearChannel(config: AgentChannelsConfig = {}) {
  return {
    adapter: withSanitizedLinearMessages(createLinearAdapter(buildLinearAdapterConfig(config))),
    cards: true,
    // Markdown fallback only; native Linear action UI comes from streamed task_update chunks.
    formatToolCall: formatLinearToolCall,
    formatError: formatLinearError,
  } satisfies ChannelAdapterConfig;
}
