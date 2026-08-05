import { z } from "zod";
import { DEFAULT_ACTIVE_ALIAS, loadModelProfile, resolveAliasModelId, type ModelProfile } from "./profile.js";

const runtimeEnvironmentSchema = z.object({
  MASTRA_TOOLKIT_MODE: z.enum(["standalone", "factory"]).default("standalone"),
  PROXY_BASE_URL: z.url().optional(),
  PROXY_API_KEY: z.string().min(1).optional(),
  CLI_PROXY_API_KEY: z.string().min(1).optional(),
  PROXY_MODEL: z.string().min(1).default(DEFAULT_ACTIVE_ALIAS),
});

export type RuntimeMode = "standalone" | "factory";

export interface ModelHostConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
}

export interface RuntimeConfig {
  readonly mode: RuntimeMode;
  readonly proxy: ModelHostConfig;
}

export function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  profile: ModelProfile = loadModelProfile(),
): RuntimeConfig {
  const parsed = runtimeEnvironmentSchema.parse(environment);
  resolveAliasModelId(profile, parsed.PROXY_MODEL);

  const profileApiKey = parseProfileApiKey(environment[profile.provider.apiKeyEnv]);
  const apiKey = parsed.PROXY_API_KEY ?? profileApiKey;
  const modelHost = {
    baseUrl: (parsed.PROXY_BASE_URL ?? profile.provider.baseUrl).replace(/\/+$/, ""),
    model: parsed.PROXY_MODEL,
  };
  return {
    mode: parsed.MASTRA_TOOLKIT_MODE,
    proxy: apiKey ? { ...modelHost, apiKey } : modelHost,
  };
}

function parseProfileApiKey(value: string | undefined): string | undefined {
  return z.string().min(1).optional().parse(value);
}
