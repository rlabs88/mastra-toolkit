import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  findSandboxSpecPath,
  loadSandboxSpec,
  type SandboxProvider,
  type SandboxSpec,
} from "./spec.js";
import type { PlatformSandboxCredentials } from "./types.js";

const PLATFORM_CREDENTIAL_KEYS = [
  "MASTRA_ENVIRONMENT_ID",
  "MASTRA_PROJECT_ID",
  "MASTRA_PLATFORM_SECRET_KEY",
] as const;

const sandboxEnvironmentSchema = z.object({
  SANDBOX_PROVIDER: z.enum(["local", "docker", "platform"]).optional(),
  SANDBOX_SPEC_PATH: z.string().min(1).optional(),
  WORKSPACE_ROOT: z.string().min(1).optional(),
  MASTRA_ENVIRONMENT_ID: z.string().min(1).optional(),
  MASTRA_PROJECT_ID: z.string().min(1).optional(),
  MASTRA_PLATFORM_SECRET_KEY: z.string().min(1).optional(),
});

export interface SandboxConfig {
  readonly provider: SandboxProvider;
  readonly workspaceRoot: string;
  readonly workdir: string;
  readonly maxSandboxes: number;
  readonly commandTimeoutMs: number;
  readonly specification: SandboxSpec;
  readonly platform?: PlatformSandboxCredentials;
}

export function loadSandboxConfig(
  environment: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
): SandboxConfig {
  const parsed = sandboxEnvironmentSchema.parse(environment);
  assertCompleteGroup(parsed, PLATFORM_CREDENTIAL_KEYS, "Platform sandbox");

  const specification = loadSandboxSpec(
    findSandboxSpecPath(parsed.SANDBOX_SPEC_PATH, startDirectory),
  );
  const platform = completePlatformCredentials(parsed);
  const config = {
    provider: parsed.SANDBOX_PROVIDER ?? specification.spec.defaultProvider,
    workspaceRoot: resolve(parsed.WORKSPACE_ROOT ?? join(homedir(), ".mastra-toolkit", "sandboxes")),
    workdir: specification.spec.workdir,
    maxSandboxes: specification.spec.maxSandboxes,
    commandTimeoutMs: specification.spec.commandTimeoutMs,
    specification,
  };
  return platform ? { ...config, platform } : config;
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

function completePlatformCredentials(
  environment: z.infer<typeof sandboxEnvironmentSchema>,
): PlatformSandboxCredentials | undefined {
  if (
    !environment.MASTRA_ENVIRONMENT_ID
    || !environment.MASTRA_PROJECT_ID
    || !environment.MASTRA_PLATFORM_SECRET_KEY
  ) {
    return undefined;
  }

  return {
    environmentId: environment.MASTRA_ENVIRONMENT_ID,
    projectId: environment.MASTRA_PROJECT_ID,
    secretKey: environment.MASTRA_PLATFORM_SECRET_KEY,
  };
}
