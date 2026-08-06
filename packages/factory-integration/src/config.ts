import { loadRuntimeConfig, type ModelProfile, type RuntimeConfig } from "@rlabs/runtime-config";
import {
  loadSandboxConfig,
  resolveSandboxRuntimeProfile,
  type SandboxConfig,
  type SandboxRuntimeProfile,
  type SandboxRuntimeProfileName,
} from "@rlabs/sandbox";
import { z } from "zod";

const factoryProjectRuntimeProfileSchema = z.enum(["ephemeral-development", "persistent-operations"])
  .default("ephemeral-development");

const factoryEnvironmentSchema = z.object({
  FACTORY_PROJECT_RUNTIME_PROFILE: factoryProjectRuntimeProfileSchema,
  FACTORY_REPOSITORY_EXECUTION: z.enum(["enabled", "disabled"]).default("enabled"),
  FACTORY_PUBLIC_URL: z.string().url().default("http://localhost:4111"),
  FACTORY_ALLOWED_ORIGINS: z.string().optional(),
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
const PERSISTENT_FACTORY_SECRET_KEYS = [
  ...WORKOS_KEYS,
  "DATABASE_URL",
  "REDIS_URL",
  "MASTRA_ENVIRONMENT_ID",
  "MASTRA_PROJECT_ID",
  "MASTRA_PLATFORM_SECRET_KEY",
] as const;

export type FactoryProjectRuntimeProfile = SandboxRuntimeProfileName;
export type FactoryProjectRuntimeConfig = SandboxRuntimeProfile;

export interface FactoryConfig {
  readonly runtime: RuntimeConfig;
  readonly sandbox?: SandboxConfig;
  readonly projectRuntime: FactoryProjectRuntimeConfig;
  readonly server: {
    readonly publicUrl: string;
    readonly allowedOrigins: readonly string[];
  };
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

export function requiredFactorySecretNames(environment: NodeJS.ProcessEnv): readonly string[] {
  const profile = factoryProjectRuntimeProfileSchema.parse(environment.FACTORY_PROJECT_RUNTIME_PROFILE);
  return profile === "persistent-operations" ? PERSISTENT_FACTORY_SECRET_KEYS : [];
}

export function loadFactoryConfig(
  environment: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
  profile?: ModelProfile,
): FactoryConfig {
  const parsed = factoryEnvironmentSchema.parse(environment);
  const publicUrl = normalizeOrigin(parsed.FACTORY_PUBLIC_URL, "FACTORY_PUBLIC_URL");
  const allowedOrigins = parsed.FACTORY_ALLOWED_ORIGINS
    ? parsed.FACTORY_ALLOWED_ORIGINS.split(",").map((value, index) =>
      normalizeOrigin(value.trim(), `FACTORY_ALLOWED_ORIGINS entry ${index + 1}`))
    : [publicUrl];
  assertCompleteGroup(parsed, GITHUB_KEYS, "GitHub App");
  assertCompleteGroup(parsed, WORKOS_KEYS, "WorkOS");
  if (
    !parsed.WORKOS_API_KEY
    && (!isLoopbackOrigin(publicUrl) || allowedOrigins.some(origin => !isLoopbackOrigin(origin)))
  ) {
    throw new Error("Factory local authentication requires loopback-only public and allowed origins");
  }
  if (
    environment.NODE_ENV === "production"
    && parsed.WORKOS_API_KEY
    && (!publicUrl.startsWith("https://") || allowedOrigins.some(origin => !origin.startsWith("https://")))
  ) {
    throw new Error("Production WorkOS authentication requires HTTPS Factory public and allowed origins");
  }
  if (parsed.GITHUB_APP_ID && !parsed.GITHUB_APP_WEBHOOK_SECRET && !parsed.WORKOS_COOKIE_PASSWORD) {
    throw new Error("GitHub App configuration requires a replica-stable state secret from GITHUB_APP_WEBHOOK_SECRET or WorkOS");
  }
  if (
    parsed.FACTORY_PROJECT_RUNTIME_PROFILE === "persistent-operations"
    && parsed.FACTORY_REPOSITORY_EXECUTION === "disabled"
  ) {
    throw new Error("The persistent-operations project runtime requires a configured repository sandbox");
  }
  const sandbox = parsed.FACTORY_REPOSITORY_EXECUTION === "enabled"
    ? loadSandboxConfig(environment, startDirectory)
    : undefined;
  if (sandbox?.provider === "docker" && !sandbox.runtimeImage) {
    throw new Error("Docker Factory repository execution requires SANDBOX_RUNTIME_IMAGE at an immutable digest");
  }
  if (parsed.FACTORY_PROJECT_RUNTIME_PROFILE === "persistent-operations" && sandbox?.provider !== "platform") {
    throw new Error("The persistent-operations project runtime requires the Platform sandbox provider");
  }
  if (parsed.FACTORY_PROJECT_RUNTIME_PROFILE === "persistent-operations" && !sandbox?.platform) {
    throw new Error("The persistent-operations project runtime requires complete Platform identity");
  }
  if (parsed.FACTORY_PROJECT_RUNTIME_PROFILE === "persistent-operations") {
    const missing = [
      ...(!parsed.DATABASE_URL ? ["DATABASE_URL"] : []),
      ...(!parsed.REDIS_URL ? ["REDIS_URL"] : []),
    ];
    if (missing.length > 0) {
      throw new Error(`The persistent-operations project runtime requires durable Factory state; missing ${missing.join(", ")}`);
    }
    if (!parsed.WORKOS_API_KEY) {
      throw new Error("The persistent-operations project runtime requires WorkOS deployment authentication");
    }
    if (!publicUrl.startsWith("https://") || allowedOrigins.some(origin => !origin.startsWith("https://"))) {
      throw new Error("The persistent-operations project runtime requires HTTPS Factory public and allowed origins");
    }
    if (environment.NODE_ENV !== "production") {
      throw new Error("The persistent-operations project runtime requires NODE_ENV=production for secure WorkOS cookies");
    }
  }
  const base = {
    runtime: loadRuntimeConfig(environment, profile),
    projectRuntime: resolveSandboxRuntimeProfile(parsed.FACTORY_PROJECT_RUNTIME_PROFILE),
    server: { publicUrl, allowedOrigins },
    ...(sandbox ? { sandbox } : {}),
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

function normalizeOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be an HTTP or HTTPS origin`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`${label} must be an origin without a path, query, credentials, or fragment`);
  }
  return url.origin;
}

function isLoopbackOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
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
