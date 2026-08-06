import defaultSandboxSpec from "../config/sandbox.config.json" with { type: "json" };

import runtimeProfiles from "../config/runtime-profiles.json" with { type: "json" };

import { z } from "zod";

import { type WorkspaceSandbox } from "@mastra/core/workspace";

import { readFileSync } from "node:fs";

import { isAbsolute, resolve, join } from "node:path";

import { fileURLToPath } from "node:url";

import { homedir } from "node:os";



export const SANDBOX_RUNTIME_IMAGE_ENV = "MASTRA_TOOLKIT_RUNTIME_IMAGE";

export const immutableSandboxImageSchema = z.string().regex(
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/,
  "Sandbox image must use an immutable sha256 digest",
);

export interface SandboxMachineBaseOptions {
  readonly workspaceRoot: string;
  readonly specification: SandboxSpec;
  readonly runtimeImage?: string;
}

export interface PlatformSandboxCredentials {
  readonly environmentId: string;
  readonly projectId: string;
  readonly secretKey: string;
}

export interface SandboxMachineOptions extends SandboxMachineBaseOptions {
  readonly provider: SandboxProvider;
  readonly platform?: PlatformSandboxCredentials | undefined;
  readonly runtimeProfile?: SandboxRuntimeProfileName;
}

export type CloneableSandboxMachine = WorkspaceSandbox & {
  readonly provider: SandboxProvider;
  clone(options?: {
    id?: string;
    sandboxId?: string;
    idleTimeoutMinutes?: number;
  }): CloneableSandboxMachine;
};

export const DEFAULT_SANDBOX_SPEC_PATH = fileURLToPath(
  new URL("../config/sandbox.config.json", import.meta.url),
);

const sandboxSpecSchema = z.object({
  $schema: z.string().optional(),
  apiVersion: z.literal("cortex.provisioning/v1"),
  kind: z.literal("SandboxRuntime"),
  metadata: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    displayName: z.string().min(1),
    version: z.number().int().positive(),
  }).strict(),
  spec: z.object({
    defaultProvider: z.enum(["local", "docker", "platform"]),
    commandTimeoutMs: z.number().int().positive(),
    maxSandboxes: z.number().int().positive(),
    workdir: z.string().startsWith("/"),
    entrypointProfile: z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      image: immutableSandboxImageSchema,
      platform: z.literal("linux/arm64"),
      abi: z.literal("sandbox-entrypoint/v1"),
      command: z.tuple([z.literal("serve")]),
      probeCommand: z.tuple([z.literal("probe")]),
    }).strict(),
    local: z.object({
      isolation: z.enum(["auto", "none", "seatbelt", "bwrap"]),
      allowNetwork: z.boolean(),
      allowSystemBinaries: z.boolean(),
      readOnly: z.boolean(),
      readOnlyPaths: z.array(z.string()),
      readWritePaths: z.array(z.string()),
    }).strict(),
    docker: z.object({
      readonlyRootfs: z.boolean(),
      capDrop: z.array(z.string()),
      securityOpt: z.array(z.string()),
      pidsLimit: z.number().int().positive(),
      memoryBytes: z.number().int().positive(),
      tmpfs: z.record(z.string(), z.string()),
    }).strict(),
    platform: z.object({
      networkIsolation: z.enum(["ISOLATED", "PRIVATE"]),
      idleTimeoutMinutes: z.number().int().positive(),
    }).strict(),
  }).strict(),
}).strict();

export type SandboxSpec = z.infer<typeof sandboxSpecSchema>;
export type SandboxProvider = SandboxSpec["spec"]["defaultProvider"];

export function parseSandboxSpec(input: unknown): SandboxSpec {
  return sandboxSpecSchema.parse(input);
}

export function findSandboxSpecPath(explicitPath?: string, startDirectory = process.cwd()): string {
  if (explicitPath) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(startDirectory, explicitPath);
  }
  return DEFAULT_SANDBOX_SPEC_PATH;
}

export function loadSandboxSpec(path: string): SandboxSpec {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read sandbox specification at ${path}`, { cause: error });
  }
  return parseSandboxSpec(input);
}

export function loadDefaultSandboxSpec(): SandboxSpec {
  return parseSandboxSpec(defaultSandboxSpec);
}

const PLATFORM_CREDENTIAL_KEYS = [
  "MASTRA_ENVIRONMENT_ID",
  "MASTRA_PROJECT_ID",
  "MASTRA_PLATFORM_SECRET_KEY",
] as const;

const sandboxEnvironmentSchema = z.object({
  SANDBOX_PROVIDER: z.enum(["local", "docker", "platform"]).optional(),
  SANDBOX_SPEC_PATH: z.string().min(1).optional(),
  SANDBOX_RUNTIME_IMAGE: immutableSandboxImageSchema.optional(),
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
  readonly runtimeImage?: string;
  readonly specification: SandboxSpec;
  readonly platform?: PlatformSandboxCredentials;
}

export function loadSandboxConfig(
  environment: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
): SandboxConfig {
  const parsed = sandboxEnvironmentSchema.parse(environment);
  assertCompleteGroup(parsed, PLATFORM_CREDENTIAL_KEYS, "Platform sandbox");

  const specification = parsed.SANDBOX_SPEC_PATH
    ? loadSandboxSpec(findSandboxSpecPath(parsed.SANDBOX_SPEC_PATH, startDirectory))
    : loadDefaultSandboxSpec();
  const platform = completePlatformCredentials(parsed);
  const config = {
    provider: parsed.SANDBOX_PROVIDER ?? specification.spec.defaultProvider,
    workspaceRoot: resolve(parsed.WORKSPACE_ROOT ?? join(homedir(), ".mastra-toolkit", "sandboxes")),
    workdir: specification.spec.workdir,
    maxSandboxes: specification.spec.maxSandboxes,
    commandTimeoutMs: specification.spec.commandTimeoutMs,
    specification,
    ...(parsed.SANDBOX_RUNTIME_IMAGE ? { runtimeImage: parsed.SANDBOX_RUNTIME_IMAGE } : {}),
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

export type SandboxRuntimeProfileName = "ephemeral-development" | "persistent-operations";

export interface SandboxRuntimeProfile {
  readonly profile: SandboxRuntimeProfileName;
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

const packageLayersSchema = z.array(z.string().min(1)).min(1);
const secretProviderSchema = z.object({
  kind: z.literal("infisical"),
  projectId: z.string().uuid(),
  environment: z.literal("dev"),
  path: z.string().startsWith("/"),
});

const SANDBOX_RUNTIME_PROFILES = z.object({
  "ephemeral-development": z.object({
    profile: z.literal("ephemeral-development"),
    lifecycle: z.literal("ephemeral"),
    packageLayers: packageLayersSchema,
    credentials: z.literal("task-scoped"),
  }),
  "persistent-operations": z.object({
    profile: z.literal("persistent-operations"),
    lifecycle: z.literal("persistent"),
    packageLayers: packageLayersSchema,
    credentials: z.literal("runtime-secret-provider"),
    secretProvider: secretProviderSchema,
  }),
}).parse(runtimeProfiles) satisfies Record<SandboxRuntimeProfileName, SandboxRuntimeProfile>;

export function resolveSandboxRuntimeProfile(profile: SandboxRuntimeProfileName): SandboxRuntimeProfile {
  return SANDBOX_RUNTIME_PROFILES[profile];
}
