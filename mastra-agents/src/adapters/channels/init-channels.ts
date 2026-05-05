import { createGitHubChannel } from "./github/index.js";
import { createLinearChannel, getLinearMode, installLinearRichStreaming } from "./linear/index.js";
import { createSlackChannel } from "./slack/index.js";
import { createChannelState } from "./state.js";
import type { AgentChannelsConfig, ChannelStatusMap } from "./types.js";
import { channelPlatforms, getEnv } from "./types.js";

type ChannelThread = {
  id?: string;
  startTyping?: (status?: string) => Promise<void>;
};

type ChannelMessage = unknown;
type DefaultChannelHandler = (thread: ChannelThread, message: ChannelMessage) => Promise<void>;

function isLinearThread(thread: ChannelThread) {
  return typeof thread.id === "string" && thread.id.startsWith("linear:");
}

async function startLinearThought(thread: ChannelThread, status: string) {
  if (!isLinearThread(thread) || typeof thread.startTyping !== "function") return;

  try {
    await thread.startTyping(status);
  } catch {
    // Typing/thought activity is best-effort. Linear comments mode does not support it.
  }
}

async function handleChannelMessageWithLinearThoughts(
  thread: ChannelThread,
  message: ChannelMessage,
  defaultHandler: DefaultChannelHandler,
) {
  await startLinearThought(thread, "Working...");
  await defaultHandler(thread, message);
}

export function resolveChannelStatus(config: AgentChannelsConfig = {}): ChannelStatusMap {
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

export const resolveAgentChannelStatus = resolveChannelStatus;

export function listEnabledChannelPlatforms(config: AgentChannelsConfig = {}) {
  const status = resolveChannelStatus(config);
  return channelPlatforms.filter((platform) => status[platform].enabled);
}

export function initChannels(config: AgentChannelsConfig = {}) {
  const adapters: Record<string, unknown> = {};
  const status = resolveChannelStatus(config);

  if (status.slack.enabled) {
    adapters.slack = createSlackChannel();
  }

  if (status.github.enabled) {
    adapters.github = createGitHubChannel();
  }

  if (status.linear.enabled) {
    installLinearRichStreaming();
    adapters.linear = createLinearChannel(config);
  }

  return Object.keys(adapters).length > 0
    ? {
      adapters,
      state: createChannelState(),
      handlers: {
        onDirectMessage: handleChannelMessageWithLinearThoughts,
        onMention: handleChannelMessageWithLinearThoughts,
        onSubscribedMessage: handleChannelMessageWithLinearThoughts,
      },
    }
    : undefined;
}
