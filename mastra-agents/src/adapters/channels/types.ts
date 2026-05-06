export const channelPlatforms = ["slack", "github", "linear"] as const;

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
    enableKey?: string;
    oauthCallbackEnableKey?: string;
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

export function getEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}
