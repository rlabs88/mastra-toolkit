import { loadRuntimeConfig, type RuntimeConfig } from "@rlabs/runtime-config";
import { loadSandboxConfig, type SandboxConfig } from "@rlabs/sandbox";
import { z } from "zod";

const factoryEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z.string().min(1).default("rlabs-mastra-toolkit"),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
  WORKOS_API_KEY: z.string().min(1).optional(),
  WORKOS_CLIENT_ID: z.string().min(1).optional(),
  WORKOS_COOKIE_PASSWORD: z.string().min(32).optional(),
});

const GITHUB_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
] as const;
const WORKOS_KEYS = ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"] as const;

export interface FactoryConfig {
  readonly runtime: RuntimeConfig;
  readonly sandbox: SandboxConfig;
  readonly databaseUrl?: string;
  readonly redisUrl?: string;
  readonly github?: {
    readonly GITHUB_APP_ID: string;
    readonly GITHUB_APP_PRIVATE_KEY: string;
    readonly GITHUB_APP_CLIENT_ID: string;
    readonly GITHUB_APP_CLIENT_SECRET: string;
    readonly GITHUB_APP_SLUG: string;
    readonly GITHUB_APP_WEBHOOK_SECRET?: string;
  };
  readonly workos?: {
    readonly apiKey: string;
    readonly clientId: string;
    readonly cookiePassword: string;
  };
}

export function loadFactoryConfig(
  environment: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
): FactoryConfig {
  const parsed = factoryEnvironmentSchema.parse(environment);
  assertCompleteGroup(parsed, GITHUB_KEYS, "GitHub App");
  assertCompleteGroup(parsed, WORKOS_KEYS, "WorkOS");
  const base = {
    runtime: loadRuntimeConfig(environment),
    sandbox: loadSandboxConfig(environment, startDirectory),
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
    ...(parsed.REDIS_URL ? { redisUrl: parsed.REDIS_URL } : {}),
  };
  const github = parsed.GITHUB_APP_ID ? {
    GITHUB_APP_ID: parsed.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: parsed.GITHUB_APP_PRIVATE_KEY!,
    GITHUB_APP_CLIENT_ID: parsed.GITHUB_APP_CLIENT_ID!,
    GITHUB_APP_CLIENT_SECRET: parsed.GITHUB_APP_CLIENT_SECRET!,
    GITHUB_APP_SLUG: parsed.GITHUB_APP_SLUG,
    ...(parsed.GITHUB_APP_WEBHOOK_SECRET
      ? { GITHUB_APP_WEBHOOK_SECRET: parsed.GITHUB_APP_WEBHOOK_SECRET }
      : {}),
  } : undefined;
  const workos = parsed.WORKOS_API_KEY ? {
    apiKey: parsed.WORKOS_API_KEY,
    clientId: parsed.WORKOS_CLIENT_ID!,
    cookiePassword: parsed.WORKOS_COOKIE_PASSWORD!,
  } : undefined;
  return { ...base, ...(github ? { github } : {}), ...(workos ? { workos } : {}) };
}

function assertCompleteGroup(
  environment: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const present = keys.filter(key => Boolean(environment[key]));
  if (present.length === 0 || present.length === keys.length) return;
  throw new Error(`${label} configuration is incomplete; missing ${keys.filter(key => !environment[key]).join(", ")}`);
}
