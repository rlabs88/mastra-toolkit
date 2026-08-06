import { loadRuntimeConfig, type RuntimeConfig } from "@rlabs/runtime-config";
import { loadSandboxConfig, type SandboxConfig } from "@rlabs/sandbox";
import { z } from "zod";

const factoryEnvironmentSchema = z.object({
  FACTORY_PROJECT_RUNTIME_PROFILE: z.enum(["ephemeral-development", "persistent-operations"])
    .default("ephemeral-development"),
  FACTORY_REPOSITORY_EXECUTION: z.enum(["enabled", "disabled"]).default("enabled"),
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

export type FactoryProjectRuntimeProfile = "ephemeral-development" | "persistent-operations";

export interface FactoryProjectRuntimeConfig {
  readonly profile: FactoryProjectRuntimeProfile;
  readonly lifecycle: "ephemeral" | "persistent";
  readonly packageLayers: readonly string[];
  readonly credentials: "task-scoped" | "runtime-secret-provider";
  readonly secretProvider?: {
    readonly kind: "infisical";
    readonly projectId: string;
    readonly environment: "dev";
    readonly path: string;
  };
}

const PROJECT_RUNTIME_PROFILES = {
  "ephemeral-development": {
    profile: "ephemeral-development",
    lifecycle: "ephemeral",
    packageLayers: ["mcode-runtime", "project-development"],
    credentials: "task-scoped",
  },
  "persistent-operations": {
    profile: "persistent-operations",
    lifecycle: "persistent",
    packageLayers: ["mcode-runtime", "project-development", "operations"],
    credentials: "runtime-secret-provider",
    secretProvider: {
      kind: "infisical",
      projectId: "0b0f6354-029f-45a7-9c1c-b65968b5f46c",
      environment: "dev",
      path: "/mastra-toolkit",
    },
  },
} as const satisfies Record<FactoryProjectRuntimeProfile, FactoryProjectRuntimeConfig>;

export interface FactoryConfig {
  readonly runtime: RuntimeConfig;
  readonly sandbox?: SandboxConfig;
  readonly projectRuntime: FactoryProjectRuntimeConfig;
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
  }
  const base = {
    runtime: loadRuntimeConfig(environment),
    projectRuntime: PROJECT_RUNTIME_PROFILES[parsed.FACTORY_PROJECT_RUNTIME_PROFILE],
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

function assertCompleteGroup(
  environment: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const present = keys.filter(key => Boolean(environment[key]));
  if (present.length === 0 || present.length === keys.length) return;
  throw new Error(`${label} configuration is incomplete; missing ${keys.filter(key => !environment[key]).join(", ")}`);
}
