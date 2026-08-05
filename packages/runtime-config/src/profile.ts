import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

export const DEFAULT_ACTIVE_ALIAS = "code-frontier-high";
export const DEFAULT_OBSERVER_ALIAS = "code-workhorse-high";
export const DEFAULT_MODEL_PROFILE_PATH = fileURLToPath(new URL("../config/models.yaml", import.meta.url));

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

export function resolveObservationalMemoryThresholds(profile: ModelProfile): Readonly<{
  observationThreshold: number;
  reflectionThreshold: number;
}> {
  const observationThreshold = profile.memory.observationThresholdTokens;
  return {
    observationThreshold,
    reflectionThreshold: profile.memory.contextBudgetTokens - observationThreshold,
  };
}
