import type { FactoryStorage } from "@mastra/core/storage";
import {
  A1_CODE_PROVIDER_ID,
  A1_CODE_PROVIDER_NAME,
  getA1CodeModelId,
  type A1ProviderOptions,
} from "@rlabs/mcode";
import type { RuntimeDefaultsV1 } from "@rlabs/runtime-config";

const LOCAL_ORG_ID = "local-org";
const LOCAL_USER_ID = "local-user";

interface CustomProvidersDomain {
  ensureReady(): Promise<void>;
  upsert(input: { orgId: string; userId: string; input: { providerId: string; name: string; url: string; apiKey?: string; models: string[] } }): Promise<unknown>;
}

interface ProjectsDomain {
  ensureReady(): Promise<void>;
  list(input: { orgId: string }): Promise<Array<{ id: string; defaultModelId: string | null }>>;
  update(input: { orgId: string; id: string; input: { defaultModelId: string } }): Promise<unknown>;
}

type ModeModels = Record<"build" | "plan" | "fast", string>;

interface ModelPacksDomain {
  ensureReady(): Promise<void>;
  list(input: { orgId: string }): Promise<Array<{ name: string; models: ModeModels }>>;
  upsert(input: { orgId: string; userId: string; input: { name: string; models: ModeModels } }): Promise<unknown>;
}

type ModelMemorySettings = {
  observerModelId: string | null;
  reflectorModelId: string | null;
  observationThreshold: number | null;
  reflectionThreshold: number | null;
};
type ModelMemorySettingsPatch = {
  observerModelId?: string;
  reflectorModelId?: string;
  observationThreshold?: number;
  reflectionThreshold?: number;
};
type ModelMemorySettingsFillIfUnset = {
  observerModelId?: string;
  reflectorModelId?: string;
};

interface MemorySettingsDomain {
  ensureReady(): Promise<void>;
  get(input: { orgId: string; userId: string }): Promise<ModelMemorySettings | null>;
  patch(input: {
    orgId: string;
    userId: string;
    patch: ModelMemorySettingsPatch;
    fillIfUnset?: ModelMemorySettingsFillIfUnset;
  }): Promise<unknown>;
}

export async function prepareLocalA1Provider(
  storage: FactoryStorage,
  provider: A1ProviderOptions,
  defaults: RuntimeDefaultsV1,
): Promise<void> {
  await seedProvider(storage, provider);
  await migrateProjectDefaults(storage);
  await migrateModelPacks(storage);
  await migrateMemorySettings(storage, defaults);
  await migrateThreadMetadata(storage);
}

async function seedProvider(storage: FactoryStorage, provider: A1ProviderOptions): Promise<void> {
  const domain = getDomain<CustomProvidersDomain>(storage, "custom-providers");
  await domain.ensureReady();
  await domain.upsert({
    orgId: LOCAL_ORG_ID,
    userId: LOCAL_USER_ID,
    input: {
      providerId: A1_CODE_PROVIDER_ID,
      name: A1_CODE_PROVIDER_NAME,
      url: provider.baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      models: [...provider.models],
    },
  });
}

async function migrateProjectDefaults(storage: FactoryStorage): Promise<void> {
  const domain = getDomain<ProjectsDomain>(storage, "projects");
  await domain.ensureReady();
  for (const project of await domain.list({ orgId: LOCAL_ORG_ID })) {
    const modelId = normalizeStoredModelId(project.defaultModelId);
    if (modelId && modelId !== project.defaultModelId) {
      await domain.update({ orgId: LOCAL_ORG_ID, id: project.id, input: { defaultModelId: modelId } });
    }
  }
}

async function migrateModelPacks(storage: FactoryStorage): Promise<void> {
  const domain = getDomain<ModelPacksDomain>(storage, "model-packs");
  await domain.ensureReady();
  for (const pack of await domain.list({ orgId: LOCAL_ORG_ID })) {
    const models = normalizeModeModels(pack.models);
    if (Object.keys(models).every(mode => models[mode as keyof ModeModels] === pack.models[mode as keyof ModeModels])) continue;
    await domain.upsert({ orgId: LOCAL_ORG_ID, userId: LOCAL_USER_ID, input: { name: pack.name, models } });
  }
}

async function migrateMemorySettings(storage: FactoryStorage, defaults: RuntimeDefaultsV1): Promise<void> {
  const domain = getDomain<MemorySettingsDomain>(storage, "memory-settings");
  await domain.ensureReady();
  const memory = await domain.get({ orgId: LOCAL_ORG_ID, userId: LOCAL_USER_ID });
  const memoryDefaults = defaults.factory;
  const normalizedModels = memory ? normalizeMemorySettings(memory) : {};
  const patch: ModelMemorySettingsPatch = {
    ...normalizedModels,
    ...(memory?.observationThreshold == null
      ? { observationThreshold: memoryDefaults.observationThreshold }
      : {}),
    ...(memory?.reflectionThreshold == null
      ? { reflectionThreshold: memoryDefaults.reflectionThreshold }
      : {}),
  };
  const fillIfUnset: ModelMemorySettingsFillIfUnset = {
    ...(memory?.observerModelId == null
      ? { observerModelId: memoryDefaults.observerModelId }
      : {}),
    ...(memory?.reflectorModelId == null
      ? { reflectorModelId: memoryDefaults.reflectorModelId }
      : {}),
  };
  if (Object.keys(patch).length > 0 || Object.keys(fillIfUnset).length > 0) {
    await domain.patch({
      orgId: LOCAL_ORG_ID,
      userId: LOCAL_USER_ID,
      patch,
      ...(Object.keys(fillIfUnset).length > 0 ? { fillIfUnset } : {}),
    });
  }
}

async function migrateThreadMetadata(storage: FactoryStorage): Promise<void> {
  const domain = await storage.getMastraStorage().getStore("memory");
  if (!domain) return;
  await domain.init();
  const { threads } = await domain.listThreads({ perPage: false });
  for (const thread of threads) {
    const metadata = normalizeModelReferences(thread.metadata ?? {});
    if (metadata.changed) {
      await domain.updateThread({ id: thread.id, title: thread.title ?? "", metadata: metadata.value });
    }
  }
}

function normalizeModeModels(models: ModeModels): ModeModels {
  return Object.fromEntries(
    Object.entries(models).map(([mode, modelId]) => [mode, normalizeStoredModelId(modelId) ?? modelId]),
  ) as ModeModels;
}

function normalizeMemorySettings(memory: ModelMemorySettings): ModelMemorySettingsPatch {
  const observerModelId = normalizeStoredModelId(memory.observerModelId);
  const reflectorModelId = normalizeStoredModelId(memory.reflectorModelId);
  return {
    ...(observerModelId && observerModelId !== memory.observerModelId ? { observerModelId } : {}),
    ...(reflectorModelId && reflectorModelId !== memory.reflectorModelId ? { reflectorModelId } : {}),
  };
}

export function normalizeStoredModelId(modelId: string | null | undefined): string | undefined {
  if (!modelId) return undefined;
  if (/^(?:mastracode\/)?a1-proxy\/gpt-5\.6-luna$/.test(modelId) || modelId === "mastracode/gpt-5.6-luna") {
    return getA1CodeModelId("code-workhorse-high");
  }
  if (modelId.startsWith("mastracode/a1-proxy/")) return modelId.slice("mastracode/".length);
  return modelId;
}

export function normalizeModelReferences(input: Record<string, unknown>): {
  value: Record<string, unknown>;
  changed: boolean;
} {
  let changed = false;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const normalized = normalizeStoredModelId(value);
      if (normalized && normalized !== value) changed = true;
      return normalized ?? value;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
    }
    return value;
  };
  return { value: visit(input) as Record<string, unknown>, changed };
}

function getDomain<T>(storage: FactoryStorage, name: string): T {
  return storage.getDomain(name) as unknown as T;
}
