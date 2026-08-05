import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMastraCodeGateway, type MastraCodeCustomProvider } from "@mastra/code-sdk/agents/model";
import { ONBOARDING_VERSION } from "@mastra/code-sdk/onboarding/index";
import {
  DEFAULT_ACTIVE_ALIAS,
  DEFAULT_OBSERVER_ALIAS,
  resolveAliasModelId,
  resolveObservationalMemoryThresholds,
  resolveProxyGatewayModelId,
  type ModelProfile,
} from "@rlabs/runtime-config";
import { CANONICAL_AGENT_IDS, CODE_MODE_IDS } from "./modes/index.js";

export const A1_CODE_PROVIDER_ID = "a1-proxy";
export const A1_CODE_PROVIDER_NAME = "A1 Proxy";

interface SettingsDocument {
  onboarding?: Record<string, unknown>;
  models?: Record<string, unknown> & {
    modeDefaults?: Record<string, string>;
    subagentModels?: Record<string, string>;
    observerModelOverride?: string | null;
    reflectorModelOverride?: string | null;
    omObservationThreshold?: number | null;
    omReflectionThreshold?: number | null;
  };
  preferences?: Record<string, unknown>;
  customProviders?: Array<{ name: string; url: string; models: string[] }>;
  [key: string]: unknown;
}

export interface A1ProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
}

export function getA1CodeModelId(model: string): string {
  return `${A1_CODE_PROVIDER_ID}/${model.replace(/^a1-proxy\//, "")}`;
}

export async function prepareCodeSdkSettings(options: {
  readonly dataDirectory?: string;
  readonly profile: ModelProfile;
  readonly provider?: Omit<A1ProviderOptions, "apiKey">;
}): Promise<string> {
  const directory = options.dataDirectory
    ?? process.env.MASTRA_APP_DATA_DIR
    ?? join(homedir(), ".mastra-toolkit", "code-sdk");
  process.env.MASTRA_APP_DATA_DIR = directory;
  await mkdir(directory, { recursive: true });
  const settingsPath = join(directory, "settings.json");
  const existing = await readSettings(settingsPath);
  const activeModelId = resolveAliasModelId(options.profile, DEFAULT_ACTIVE_ALIAS);
  const observerModelId = resolveAliasModelId(options.profile, DEFAULT_OBSERVER_ALIAS);
  const memoryThresholds = resolveObservationalMemoryThresholds(options.profile);
  const existingModels = existing.models ?? {};
  const existingPreferences = existing.preferences ?? {};
  const settings: SettingsDocument = {
    ...existing,
    onboarding: {
      ...(existing.onboarding ?? {}),
      version: ONBOARDING_VERSION,
      completedAt: new Date(0).toISOString(),
      quietModePreferenceSelected: true,
    },
    models: {
      ...existingModels,
      modeDefaults: Object.fromEntries(CODE_MODE_IDS.map(id => [
        id,
        resolvePersistedModelId(existingModels.modeDefaults?.[id], options.profile) ?? activeModelId,
      ])),
      subagentModels: Object.fromEntries(CANONICAL_AGENT_IDS.map(id => [
        id,
        resolveProxyGatewayModelId(options.profile, options.profile.roles[id]),
      ])),
      observerModelOverride: resolvePersistedModelId(existingModels.observerModelOverride, options.profile) ?? observerModelId,
      reflectorModelOverride: resolvePersistedModelId(existingModels.reflectorModelOverride, options.profile) ?? observerModelId,
      omObservationThreshold: existingModels.omObservationThreshold ?? memoryThresholds.observationThreshold,
      omReflectionThreshold: existingModels.omReflectionThreshold ?? memoryThresholds.reflectionThreshold,
    },
    preferences: {
      ...existingPreferences,
      ...(!Object.hasOwn(existingPreferences, "yolo") ? { yolo: false } : {}),
      ...(!Object.hasOwn(existingPreferences, "thinkingLevel") ? { thinkingLevel: "off" } : {}),
    },
    ...(options.provider ? {
      customProviders: [
        ...(existing.customProviders ?? []).filter(provider => provider.name !== A1_CODE_PROVIDER_NAME),
        {
          name: A1_CODE_PROVIDER_NAME,
          url: options.provider.baseUrl,
          models: [...options.provider.models],
        },
      ],
    } : {}),
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return directory;
}

export function createA1CodeProvider(options: A1ProviderOptions): MastraCodeCustomProvider {
  return {
    // The matching name keeps the Code gateway catalog on the resolvable
    // `a1-proxy/<alias>` namespace instead of adding a MastraCode prefix.
    name: A1_CODE_PROVIDER_NAME,
    url: options.baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    models: [...options.models],
  };
}

export function createA1MastraCodeGateway(options: A1ProviderOptions) {
  return createMastraCodeGateway({
    mastraGatewayBaseUrl: options.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, ""),
    routeThroughMastraGateway: false,
    customProviders: [createA1CodeProvider(options)],
  });
}

function resolvePersistedModelId(
  modelId: string | null | undefined,
  profile: ModelProfile,
): string | undefined {
  if (!modelId) return undefined;
  const prefix = `${A1_CODE_PROVIDER_ID}/`;
  if (!modelId.startsWith(prefix)) {
    throw new Error(`Persisted model must use a stable A1 model alias: ${modelId}`);
  }
  resolveAliasModelId(profile, modelId.slice(prefix.length));
  return modelId;
}

async function readSettings(settingsPath: string): Promise<SettingsDocument> {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8")) as SettingsDocument;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Mastra Code SDK settings: ${settingsPath}`, { cause: error });
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}
