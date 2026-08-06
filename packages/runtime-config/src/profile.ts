import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { z } from "zod";

export const DEFAULT_ACTIVE_ALIAS = "code-frontier-high";
export const A1_PROXY_PROVIDER_ID = "a1-proxy";
export const A1_PROXY_PROVIDER_NAME = "A1 Proxy";
export const HOST_BACKGROUND_TASK_POLICY = {
  enabled: true,
  mode: "full",
  globalConcurrency: 4,
  perAgentConcurrency: 1,
  backpressure: "reject",
  defaultTimeoutMs: 180_000,
  waitTimeoutMs: 5_000,
} as const;
export const AGENT_BACKGROUND_TASK_POLICY = {
  tools: "all",
  concurrency: 1,
  waitTimeoutMs: 5_000,
} as const;
export const DEFAULT_OBSERVER_ALIAS = "code-workhorse-high";
export const DEFAULT_MODEL_PROFILE_PATH = createRequire(import.meta.url).resolve("@rlabs/runtime-config/models.yaml");

const modelProfileSchema = z.object({
  version: z.literal(1),
  provider: z.object({
    id: z.literal("a1-proxy"),
    name: z.string().min(1),
    kind: z.literal("openai-compatible"),
    baseUrl: z.url(),
    apiKeyEnv: z.string().min(1),
  }).strict(),
  aliases: z.array(z.string().min(1)).min(1),
  roles: z.object({
    cortex: z.string().min(1),
    flux: z.string().min(1),
    zen: z.string().min(1),
    specialist: z.string().min(1),
    observer: z.string().min(1),
    reflector: z.string().min(1),
  }).strict(),
  code: z.object({
    defaultAgent: z.literal("cortex"),
    defaultMode: z.literal("build"),
  }).strict(),
  memory: z.object({
    contextBudgetTokens: z.number().int().positive(),
    observationThresholdTokens: z.number().int().positive(),
  }).strict(),
}).strict().superRefine((profile, context) => {
  const aliases = new Set(profile.aliases);
  for (const [role, alias] of Object.entries(profile.roles)) {
    if (aliases.has(alias)) continue;
    context.addIssue({
      code: "custom",
      path: ["roles", role],
      message: `Unknown model alias: ${alias}`,
    });
  }

  if (profile.memory.observationThresholdTokens >= profile.memory.contextBudgetTokens) {
    context.addIssue({
      code: "custom",
      path: ["memory", "observationThresholdTokens"],
      message: "Observation threshold must be lower than the context budget",
    });
  }
});

export type ModelProfile = Readonly<z.infer<typeof modelProfileSchema>>;
export type ModelAlias = ModelProfile["aliases"][number];
export const RUNTIME_DEFAULTS_VERSION = 1 as const;

type ModelRole = keyof ModelProfile["roles"];

export interface RuntimeDefaultsV1 {
  readonly version: typeof RUNTIME_DEFAULTS_VERSION;
  readonly models: {
    readonly providerId: string;
    readonly aliases: readonly string[];
    readonly roles: Readonly<Record<ModelRole, {
      readonly alias: string;
      readonly providerModelId: string;
      readonly gatewayModelId: string;
    }>>;
  };
  readonly memory: {
    readonly contextWindowTokens: number;
    readonly secondaryInputTokens: number;
  };
  readonly codeSdk: {
    readonly activeModelId: string;
    readonly observerModelId: string;
    readonly reflectorModelId: string;
    readonly observationThreshold: number;
    readonly reflectionThreshold: number;
  };
  readonly factory: {
    readonly observerModelId: string;
    readonly reflectorModelId: string;
    readonly observationThreshold: number;
    readonly reflectionThreshold: number;
  };
  readonly gateway: {
    readonly models: readonly string[];
  };
}

export function loadModelProfile(path = DEFAULT_MODEL_PROFILE_PATH): ModelProfile {
  return Object.freeze(modelProfileSchema.parse(parse(readFileSync(path, "utf8"))));
}

export function resolveAliasModelId(profile: ModelProfile, alias: string): string {
  if (!profile.aliases.includes(alias)) {
    throw new Error(`Unknown model alias: ${alias}`);
  }
  return `${profile.provider.id}/${alias}`;
}

export function resolveProxyGatewayModelId(profile: ModelProfile, alias: string): string {
  return `proxy/${resolveAliasModelId(profile, alias)}`;
}

export function getA1ProxyModelId(model: string): string {
  return `${A1_PROXY_PROVIDER_ID}/${model.replace(/^a1-proxy\//, "")}`;
}

export function resolveRuntimeDefaultsV1(profile: ModelProfile): RuntimeDefaultsV1 {
  const aliases = Object.freeze([...profile.aliases]);
  const roles = Object.freeze(Object.fromEntries(
    Object.entries(profile.roles).map(([role, alias]) => [role, Object.freeze({
      alias,
      providerModelId: resolveAliasModelId(profile, alias),
      gatewayModelId: resolveProxyGatewayModelId(profile, alias),
    })]),
  ) as RuntimeDefaultsV1["models"]["roles"]);
  const observationThreshold = profile.memory.contextBudgetTokens;
  const reflectionThreshold = profile.memory.contextBudgetTokens - profile.memory.observationThresholdTokens;
  const observerModelId = roles.observer.providerModelId;
  const reflectorModelId = roles.reflector.providerModelId;
  const memoryDefaults = Object.freeze({
    observerModelId,
    reflectorModelId,
    observationThreshold,
    reflectionThreshold,
  });

  return Object.freeze({
    version: RUNTIME_DEFAULTS_VERSION,
    models: Object.freeze({ providerId: profile.provider.id, aliases, roles }),
    memory: Object.freeze({
      contextWindowTokens: profile.memory.contextBudgetTokens,
      secondaryInputTokens: profile.memory.observationThresholdTokens,
    }),
    codeSdk: Object.freeze({
      activeModelId: resolveAliasModelId(profile, profile.roles[profile.code.defaultAgent]),
      ...memoryDefaults,
    }),
    factory: memoryDefaults,
    gateway: Object.freeze({ models: aliases }),
  });
}

export function resolveObservationalMemoryThresholds(profile: ModelProfile): Readonly<{
  observationThreshold: number;
  reflectionThreshold: number;
}> {
  const defaults = resolveRuntimeDefaultsV1(profile);
  return Object.freeze({
    observationThreshold: defaults.codeSdk.observationThreshold,
    reflectionThreshold: defaults.codeSdk.reflectionThreshold,
  });
}
