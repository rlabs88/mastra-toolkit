import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { z } from "zod";

export const DEFAULT_ACTIVE_ALIAS = "code-frontier-high";
export const A1_PROXY_PROVIDER_ID = "a1-proxy";
export const A1_PROXY_PROVIDER_NAME = "A1 Proxy";
export const HOST_BACKGROUND_TASK_POLICY = Object.freeze({
  enabled: true,
  mode: "full",
  globalConcurrency: 4,
  perAgentConcurrency: 1,
  backpressure: "reject",
  defaultTimeoutMs: 180_000,
  waitTimeoutMs: 5_000,
} as const);
export const AGENT_BACKGROUND_TASK_POLICY = Object.freeze({
  tools: "all",
  concurrency: 1,
  waitTimeoutMs: 5_000,
} as const);
export const DEFAULT_OBSERVER_ALIAS = "code-workhorse-high";
export const DEFAULT_MODEL_PROFILE_PATH = createRequire(import.meta.url).resolve("@rlabs/runtime-config/models.yaml");

/**
 * Capability tags a preset card may advertise. They exist so a consumer can ask
 * for what it needs (`selectModelAlias(profile, { capabilities: ["vision"] })`)
 * instead of hardcoding an alias name.
 */
export const MODEL_CAPABILITIES = [
  "code",
  "reasoning",
  "long-context",
  "vision",
  "fast",
  "economical",
  "general",
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/**
 * Upstream mirrors: used only to fill a card field the profile left unset, so a
 * partial card behaves the way Mastra itself would.
 *
 * - buffer ratio 1/5 matches the Mastra Code SDK literal at
 *   `dist/agents/memory.js:90`
 * - activation 0.8 matches the documented default in Mastra core at
 *   `dist/memory/types.d.ts:439`
 */
const DEFAULT_OBSERVATION_BUFFER_RATIO = 1 / 5;
const DEFAULT_OBSERVATION_BUFFER_ACTIVATION = 0.8;

/**
 * Observation settings a card may declare but that no host can honour, because
 * upstream hardcodes them with no settings key.
 *
 * Verified by reading the installed Mastra Code SDK, not inferred:
 * `bufferTokens` and `bufferActivation` occur nowhere in that package's `dist`
 * except `dist/agents/memory.js` itself — no zod schema entry and no settings
 * field, unlike `observationThreshold` (`dist/schema.d.ts:51`), which is how
 * `messageTokens` reaches upstream.
 *
 * `evidence` paths are relative to the Mastra Code SDK package root. This
 * package is host-neutral and must not name host packages in source; the
 * fully-qualified references live in `config/models.yaml` and `CONTEXT.md`.
 *
 * Published so the gap is auditable rather than silent. Nothing in
 * `RuntimeDefaultsV1` carries these; a contract test asserts no host projection
 * serializes either key.
 */
export const UPSTREAM_BLOCKED_OBSERVATION_SETTINGS = Object.freeze([
  Object.freeze({
    setting: "observation.bufferTokens",
    cardField: "observation.bufferTokens",
    upstreamLiteral: "isResourceScope ? false : 1 / 5",
    evidence: "dist/agents/memory.js:90",
  }),
  Object.freeze({
    setting: "observation.bufferActivation",
    cardField: "observation.bufferActivation",
    upstreamLiteral: "isResourceScope ? void 0 : 2e3",
    evidence: "dist/agents/memory.js:91",
  }),
] as const);

/**
 * A preset card. Every field is optional: the card is an override layer over
 * the profile-level `memory` budget, so adding an alias never forces a full
 * card and `aliases` keeps its flat `string[]` shape.
 */
const modelCardSchema = z.object({
  contextWindowTokens: z.number().int().positive().optional(),
  capabilities: z.array(z.enum(MODEL_CAPABILITIES)).optional(),
  observation: z.object({
    messageTokens: z.number().int().positive().optional(),
    bufferTokens: z.number().int().positive().optional(),
    bufferActivation: z.number().gt(0).lte(1).optional(),
  }).strict().optional(),
  reflection: z.object({
    observationTokens: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();

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
  modelCards: z.record(z.string().min(1), modelCardSchema).default({}),
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

  for (const alias of Object.keys(profile.modelCards)) {
    if (aliases.has(alias)) continue;
    context.addIssue({
      code: "custom",
      path: ["modelCards", alias],
      // A card that names no declared alias is dead configuration; rejecting it
      // keeps the catalog and the card map from drifting apart silently.
      message: `Undeclared model alias: ${alias}`,
    });
  }

  for (const alias of profile.aliases) {
    const card = resolveCard(profile, alias);
    if (card.observation.messageTokens > card.contextWindowTokens) {
      context.addIssue({
        code: "custom",
        path: ["modelCards", alias, "observation", "messageTokens"],
        message: `Observation budget for ${alias} must fit the model's context window`,
      });
    }
    if (card.reflection.observationTokens > card.observation.messageTokens) {
      context.addIssue({
        code: "custom",
        path: ["modelCards", alias, "reflection", "observationTokens"],
        message: `Reflection budget for ${alias} must not exceed the model's observation budget`,
      });
    }
    // Upstream requires the buffer interval to resolve below the activation
    // threshold (@mastra/core/dist/memory/types.d.ts:410). Enforced even though
    // the value is upstream-blocked, so the declared intent stays valid.
    if (card.observation.bufferTokens >= card.observation.messageTokens) {
      context.addIssue({
        code: "custom",
        path: ["modelCards", alias, "observation", "bufferTokens"],
        message: `Buffer interval for ${alias} must be lower than the observation budget`,
      });
    }
  }
});

export type ModelProfile = Readonly<z.infer<typeof modelProfileSchema>>;
export type ModelAlias = ModelProfile["aliases"][number];
export const RUNTIME_DEFAULTS_VERSION = 1 as const;

type ModelRole = keyof ModelProfile["roles"];

/** A preset card with every fallback already applied. */
export interface ModelCard {
  readonly alias: string;
  readonly contextWindowTokens: number;
  readonly capabilities: readonly ModelCapability[];
  readonly observation: {
    readonly messageTokens: number;
    /** Declared intent only — upstream-blocked, see UPSTREAM_BLOCKED_OBSERVATION_SETTINGS. */
    readonly bufferTokens: number;
    /** Declared intent only — upstream-blocked, see UPSTREAM_BLOCKED_OBSERVATION_SETTINGS. */
    readonly bufferActivation: number;
  };
  readonly reflection: {
    readonly observationTokens: number;
  };
}

/** What a consumer needs, rather than which alias it thinks provides it. */
export interface ModelSelection {
  readonly capabilities?: readonly ModelCapability[];
  readonly minContextWindowTokens?: number;
  readonly minObservationMessageTokens?: number;
}

interface ModelCardSource {
  readonly memory: {
    readonly contextBudgetTokens: number;
    readonly observationThresholdTokens: number;
  };
  readonly modelCards: Readonly<Record<string, z.infer<typeof modelCardSchema>>>;
}

/**
 * Merges a declared card over the profile-level fallback budget. Kept free of
 * side effects and of any write back into the profile, so a loaded profile
 * round-trips through YAML unchanged.
 */
function resolveCard(source: ModelCardSource, alias: string): ModelCard {
  const card = source.modelCards[alias];
  const contextWindowTokens = card?.contextWindowTokens ?? source.memory.contextBudgetTokens;
  const messageTokens = card?.observation?.messageTokens ?? contextWindowTokens;
  return Object.freeze({
    alias,
    contextWindowTokens,
    capabilities: Object.freeze([...(card?.capabilities ?? [])]),
    observation: Object.freeze({
      messageTokens,
      bufferTokens: card?.observation?.bufferTokens
        ?? Math.round(messageTokens * DEFAULT_OBSERVATION_BUFFER_RATIO),
      bufferActivation: card?.observation?.bufferActivation ?? DEFAULT_OBSERVATION_BUFFER_ACTIVATION,
    }),
    reflection: Object.freeze({
      observationTokens: card?.reflection?.observationTokens
        ?? source.memory.contextBudgetTokens - source.memory.observationThresholdTokens,
    }),
  });
}

/** Resolves the preset card for a declared alias, rejecting anything else. */
export function resolveModelCard(profile: ModelProfile, alias: string): ModelCard {
  if (!profile.aliases.includes(alias)) {
    throw new Error(`Unknown model alias: ${alias}`);
  }
  return resolveCard(profile, alias);
}

/**
 * Returns the first declared alias whose card satisfies every stated
 * requirement. Catalog order is the preference order, so selection is
 * deterministic and reviewable in `models.yaml`.
 */
export function selectModelAlias(profile: ModelProfile, selection: ModelSelection): string {
  for (const alias of profile.aliases) {
    const card = resolveCard(profile, alias);
    if (selection.capabilities?.some(capability => !card.capabilities.includes(capability))) continue;
    if (selection.minContextWindowTokens !== undefined
      && card.contextWindowTokens < selection.minContextWindowTokens) continue;
    if (selection.minObservationMessageTokens !== undefined
      && card.observation.messageTokens < selection.minObservationMessageTokens) continue;
    return alias;
  }
  throw new Error(`No model card satisfies the requested capabilities: ${JSON.stringify(selection)}`);
}

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
  // The conversation the Observer actually watches belongs to the default
  // agent, so its card — not a global budget — sets both host thresholds.
  // Upstream consumes them as two distinct settings: observationThreshold
  // becomes `observation.messageTokens` (memory.js:93) and reflectionThreshold
  // becomes `reflection.observationTokens` (memory.js:104).
  const activeCard = resolveCard(profile, profile.roles[profile.code.defaultAgent]);
  const observationThreshold = activeCard.observation.messageTokens;
  const reflectionThreshold = activeCard.reflection.observationTokens;
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
      contextWindowTokens: activeCard.contextWindowTokens,
      secondaryInputTokens: activeCard.reflection.observationTokens,
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
