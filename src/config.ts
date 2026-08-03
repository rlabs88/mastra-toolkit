import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { findSandboxSpecPath, loadSandboxSpec, type SandboxSpec } from "./sandbox/spec.js";

const DEFAULT_PROXY_BASE_URL = "https://aa.renaissancelab.org/v1";
const DEFAULT_PROXY_MODEL = "openai/gpt-5.6-luna";
const GITHUB_APP_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
] as const;
const GITHUB_REQUIRED_KEYS = GITHUB_APP_KEYS.filter(key => key !== "GITHUB_APP_SLUG");

const environmentSchema = z.object({
  MASTRA_TOOLKIT_MODE: z.enum(["standalone", "factory"]).default("standalone"),
  PROXY_BASE_URL: z.url().default(DEFAULT_PROXY_BASE_URL),
  PROXY_API_KEY: z.string().min(1).optional(),
  CLI_PROXY_API_KEY: z.string().min(1).optional(),
  PROXY_MODEL: z.string().min(1).default(DEFAULT_PROXY_MODEL),
  SANDBOX_PROVIDER: z.enum(["local", "docker", "platform"]).optional(),
  SANDBOX_SPEC_PATH: z.string().min(1).optional(),
  WORKSPACE_ROOT: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  MASTRA_ENVIRONMENT_ID: z.string().min(1).optional(),
  MASTRA_PROJECT_ID: z.string().min(1).optional(),
  MASTRA_PLATFORM_SECRET_KEY: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z.string().min(1).default("rlabs-mastra-toolkit"),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
  WORKOS_API_KEY: z.string().min(1).optional(),
  WORKOS_CLIENT_ID: z.string().min(1).optional(),
  WORKOS_COOKIE_PASSWORD: z.string().min(32).optional(),
  BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
  BROWSER_USER_DATA_DIR: z.string().min(1).optional(),
});

export type ToolkitMode = "standalone" | "factory";
export type SandboxProvider = "local" | "docker" | "platform";

export interface ToolkitConfig {
  readonly mode: ToolkitMode;
  readonly proxy: {
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly model: string;
  };
  readonly sandbox: {
    readonly provider: SandboxProvider;
    readonly workspaceRoot: string;
    readonly workdir: string;
    readonly maxSandboxes: number;
    readonly commandTimeoutMs: number;
    readonly specification: SandboxSpec;
  };
  readonly databaseUrl?: string;
  readonly redisUrl?: string;
  readonly platform?: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly secretKey: string;
  };
  readonly github?: Record<(typeof GITHUB_APP_KEYS)[number], string> & {
    readonly GITHUB_APP_WEBHOOK_SECRET?: string;
  };
  readonly workos?: {
    readonly apiKey: string;
    readonly clientId: string;
    readonly cookiePassword: string;
  };
  readonly browser: {
    readonly executablePath?: string;
    readonly userDataDir?: string;
  };
}

export function loadToolkitConfig(environment: NodeJS.ProcessEnv = process.env): ToolkitConfig {
  const parsed = environmentSchema.parse(environment);
  const specification = loadSandboxSpec(findSandboxSpecPath(parsed.SANDBOX_SPEC_PATH));
  assertCompleteGroup(parsed, GITHUB_REQUIRED_KEYS, "GitHub App");
  assertCompleteGroup(parsed, ["MASTRA_ENVIRONMENT_ID", "MASTRA_PROJECT_ID", "MASTRA_PLATFORM_SECRET_KEY"], "Platform sandbox");
  assertCompleteGroup(parsed, ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"], "WorkOS");

  const workspaceRoot = resolve(parsed.WORKSPACE_ROOT ?? join(homedir(), ".mastra-toolkit", "sandboxes"));
  const proxyApiKey = parsed.PROXY_API_KEY ?? parsed.CLI_PROXY_API_KEY;

  return removeUndefined({
    mode: parsed.MASTRA_TOOLKIT_MODE,
    proxy: removeUndefined({
      baseUrl: parsed.PROXY_BASE_URL.replace(/\/+$/, ""),
      apiKey: proxyApiKey,
      model: parsed.PROXY_MODEL,
    }),
    sandbox: {
      provider: parsed.SANDBOX_PROVIDER ?? specification.spec.defaultProvider,
      workspaceRoot,
      workdir: specification.spec.workdir,
      maxSandboxes: specification.spec.maxSandboxes,
      commandTimeoutMs: specification.spec.commandTimeoutMs,
      specification,
    },
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    platform: completePlatform(parsed),
    github: completeGithub(parsed),
    workos: completeWorkos(parsed),
    browser: removeUndefined({
      executablePath: parsed.BROWSER_EXECUTABLE_PATH,
      userDataDir: parsed.BROWSER_USER_DATA_DIR,
    }),
  }) as ToolkitConfig;
}

function assertCompleteGroup(
  environment: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const present = keys.filter(key => Boolean(environment[key]));
  if (present.length === 0 || present.length === keys.length) return;
  const missing = keys.filter(key => !environment[key]);
  throw new Error(`${label} configuration is incomplete; missing ${missing.join(", ")}`);
}

function completePlatform(environment: z.infer<typeof environmentSchema>): ToolkitConfig["platform"] {
  if (!environment.MASTRA_ENVIRONMENT_ID || !environment.MASTRA_PROJECT_ID || !environment.MASTRA_PLATFORM_SECRET_KEY) return undefined;
  return {
    environmentId: environment.MASTRA_ENVIRONMENT_ID,
    projectId: environment.MASTRA_PROJECT_ID,
    secretKey: environment.MASTRA_PLATFORM_SECRET_KEY,
  };
}

function completeGithub(environment: z.infer<typeof environmentSchema>): ToolkitConfig["github"] {
  if (!environment.GITHUB_APP_ID) return undefined;
  const values = environment as Record<string, string | undefined>;
  return removeUndefined(Object.fromEntries(
    [...GITHUB_APP_KEYS, "GITHUB_APP_WEBHOOK_SECRET"].map(key => [key, values[key]]),
  )) as ToolkitConfig["github"];
}

function completeWorkos(environment: z.infer<typeof environmentSchema>): ToolkitConfig["workos"] {
  if (!environment.WORKOS_API_KEY || !environment.WORKOS_CLIENT_ID || !environment.WORKOS_COOKIE_PASSWORD) return undefined;
  return {
    apiKey: environment.WORKOS_API_KEY,
    clientId: environment.WORKOS_CLIENT_ID,
    cookiePassword: environment.WORKOS_COOKIE_PASSWORD,
  };
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
