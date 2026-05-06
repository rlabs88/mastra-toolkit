import { createLinearAdapter } from "@chat-adapter/linear";
import type { LinearAdapterMode } from "@chat-adapter/linear";
import type { ChannelAdapterConfig } from "@mastra/core/channels";

import type { AgentChannelsConfig } from "../types.js";
import { getEnv } from "../types.js";
import { formatLinearError } from "./format-linear-error.js";
import { formatLinearToolCall } from "./format-linear-tool-call.js";

type LinearMessage = {
  text?: string;
  threadId?: string;
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

function getStableLinearAgentSessionThreadId(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;

  const candidate = raw as {
    kind?: unknown;
    agentSessionId?: unknown;
    comment?: { issueId?: unknown };
  };

  const agentSessionId = candidate.agentSessionId;
  const issueId = candidate.comment?.issueId;

  if (candidate.kind !== "agent_session_comment") return undefined;
  if (typeof agentSessionId !== "string" || !agentSessionId) return undefined;
  if (typeof issueId !== "string" || !issueId) return undefined;

  // Chat SDK currently builds prompted Linear Agent Session thread ids from
  // sourceCommentId. That id changes for each follow-up, which fragments Mastra
  // memory, subscription state, and locks. The Linear Agent Session id is the
  // durable conversation boundary, so normalize all session prompts to it.
  return `linear:${issueId}:s:${agentSessionId}`;
}

export function normalizeLinearMessage(raw: unknown, message: LinearMessage) {
  if (typeof message.text === "string") {
    message.text = sanitizeLinearMessageText(message.text);
  }

  const stableAgentSessionThreadId = getStableLinearAgentSessionThreadId(raw);
  if (stableAgentSessionThreadId) {
    message.threadId = stableAgentSessionThreadId;
  }

  return message;
}

function withNormalizedLinearMessages(adapter: ReturnType<typeof createLinearAdapter>) {
  const linearAdapter = adapter as LinearAdapterWithParseMessage;
  const parseMessage = linearAdapter.parseMessage?.bind(linearAdapter);
  if (!parseMessage) return adapter;

  linearAdapter.parseMessage = (raw: unknown) => {
    return normalizeLinearMessage(raw, parseMessage(raw));
  };

  return adapter;
}

export function createLinearChannel(config: AgentChannelsConfig = {}) {
  return {
    adapter: withNormalizedLinearMessages(createLinearAdapter(buildLinearAdapterConfig(config))),
    cards: true,
    // Markdown fallback only; native Linear action UI comes from streamed task_update chunks.
    formatToolCall: formatLinearToolCall,
    formatError: formatLinearError,
  } satisfies ChannelAdapterConfig;
}
