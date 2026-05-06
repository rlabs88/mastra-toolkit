import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { MastraAcpSession } from './types.js';

export type AcpRuntimeAgentId = 'orchestrator' | 'supervisor';

export type AcpModeDefinition = {
  id: string;
  name: string;
  agentId: AcpRuntimeAgentId;
  harnessMode: string;
  harnessModeId: string;
  default: boolean;
  prompt: string;
};

export type AcpRuntimeConfig = {
  agentId: AcpRuntimeAgentId;
  modes: AcpModeDefinition[];
  defaultModeId: string;
  models: string[];
  defaultModelId: string;
};

const modeAliases = new Map<string, SupervisorModeId>([
  ['base', 'base'],
  ['balance', 'base'],
  ['balanced', 'base'],
  ['scope', 'scope'],
  ['spec', 'spec'],
  ['plan', 'spec'],
  ['exec', 'exec'],
  ['execution', 'exec'],
  ['build', 'exec'],
  ['verify', 'exec'],
]);

type SupervisorModeId = 'base' | 'scope' | 'spec' | 'exec';

const configCache = new Map<string, Promise<AcpRuntimeConfig>>();

export function runtimeAgentIdFromAgentId(agentId: string | undefined): AcpRuntimeAgentId {
  const normalized = agentId?.trim().toLowerCase().replace(/_/g, '-') ?? '';
  return normalized.includes('orchestrator') ? 'orchestrator' : 'supervisor';
}

export function loadAcpRuntimeConfig(agentId: string | undefined, mastraBaseUrl?: string): Promise<AcpRuntimeConfig> {
  const runtimeAgentId = runtimeAgentIdFromAgentId(agentId);
  const cacheKey = `${runtimeAgentId}:${mastraBaseUrl ?? ''}`;
  const existing = configCache.get(cacheKey);
  if (existing) return existing;

  const config = loadMastraRuntimeConfig(runtimeAgentId, agentId, mastraBaseUrl)
    .catch(async () => fallbackRuntimeConfig(runtimeAgentId, await modelIdFromMastraAgentApi(agentId, mastraBaseUrl)));
  configCache.set(cacheKey, config);
  return config;
}

export function normalizeModeId(value: unknown, config: AcpRuntimeConfig): string {
  if (typeof value !== 'string' || !value.trim()) return config.defaultModeId;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  const aliased = config.agentId === 'supervisor' ? modeAliases.get(normalized) : undefined;
  const requested = aliased ?? normalized.split('.').at(-1) ?? normalized;
  return config.modes.some((mode) => mode.id === requested) ? requested : config.defaultModeId;
}

export function normalizeModelId(value: unknown, config: AcpRuntimeConfig): string {
  if (typeof value !== 'string' || !value.trim()) return config.defaultModelId;
  const modelId = value.trim();
  return modelId.startsWith('rl/') ? config.defaultModelId : modelId;
}

export function modeDefinitionForSession(session: MastraAcpSession, config: AcpRuntimeConfig): AcpModeDefinition {
  const modeId = normalizeModeId(session.modeId, config);
  return config.modes.find((mode) => mode.id === modeId) ?? config.modes[0];
}

export function modelOptionsForSession(session: MastraAcpSession, config: AcpRuntimeConfig): string[] {
  return unique([normalizeModelId(session.modelId, config), ...config.models]);
}

export function buildConfigOptions(session: MastraAcpSession, config: AcpRuntimeConfig): SessionConfigOption[] {
  const modeId = normalizeModeId(session.modeId, config);
  const modelId = normalizeModelId(session.modelId, config);
  return [
    { id:'mode', name:'Mode', category:'mode', type:'select', currentValue: modeId, options: config.modes.map(v=>({value:v.id,name:v.name})) },
    { id:'model', name:'Model', category:'model', type:'select', currentValue: modelId, options: modelOptionsForSession(session, config).map(v=>({value:v,name:v})) },
    { id:'thinking', name:'Thinking', category:'thought_level', type:'select', currentValue: session.thinkingOptionId ?? 'medium', options: ['low','medium','high'].map(v=>({value:v,name:v[0].toUpperCase()+v.slice(1)})) },
  ];
}

async function loadMastraRuntimeConfig(agentId: AcpRuntimeAgentId, apiAgentId: string | undefined, mastraBaseUrl: string | undefined): Promise<AcpRuntimeConfig> {
  const harnessModule = await import(new URL('../agents/harness.js', import.meta.url).href);
  const modes = harnessModule.mastraAgentHarnessModes
    .filter((mode: { id: string }) => mode.id.startsWith(`${agentId}.`))
    .map((mode: { id: string; name: string; default?: boolean; defaultModelId?: string }) => {
      const resolved = harnessModule.resolveMastraAgentHarnessMode({ agentId, harnessMode: mode.id });
      return {
        id: resolved.harnessMode,
        name: mode.name,
        agentId: resolved.activeAgentId,
        harnessMode: resolved.harnessMode,
        harnessModeId: resolved.harnessModeId,
        default: Boolean(mode.default),
        prompt: harnessModule.formatMastraAgentHarnessModePrompt(resolved),
        defaultModelId: mode.defaultModelId,
      };
    });

  const defaultMode = modes.find((mode: AcpModeDefinition) => mode.default) ?? modes[0];
  const configuredModels = unique([
    ...modes.map((mode: AcpModeDefinition & { defaultModelId?: string }) => mode.defaultModelId),
    ...configuredModelEnvValues(agentId),
    await modelIdFromMastraAgentApi(apiAgentId, mastraBaseUrl),
  ]);
  const defaultModelId = configuredModels[0] ?? 'minimax-coding-plan/MiniMax-M2.7';

  return {
    agentId,
    modes,
    defaultModeId: defaultMode?.id ?? fallbackRuntimeConfig(agentId).defaultModeId,
    models: configuredModels.length > 0 ? configuredModels : [defaultModelId],
    defaultModelId,
  };
}

async function modelIdFromMastraAgentApi(agentId: string | undefined, mastraBaseUrl: string | undefined): Promise<string | undefined> {
  if (!agentId || !mastraBaseUrl) return undefined;
  try {
    const baseUrl = mastraBaseUrl.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}`);
    if (!response.ok) return undefined;
    const agentConfig = await response.json() as { provider?: unknown; modelId?: unknown };
    const provider = typeof agentConfig.provider === 'string' ? agentConfig.provider.trim() : '';
    const modelId = typeof agentConfig.modelId === 'string' ? agentConfig.modelId.trim() : '';
    if (!modelId) return undefined;
    return provider && !modelId.startsWith(`${provider}/`) ? `${provider}/${modelId}` : modelId;
  } catch {
    return undefined;
  }
}

function fallbackRuntimeConfig(agentId: AcpRuntimeAgentId, apiModelId?: string): AcpRuntimeConfig {
  const models = unique([...configuredModelEnvValues(agentId), apiModelId]);
  const defaultModelId = models[0] ?? 'minimax-coding-plan/MiniMax-M2.7';
  const fallbackModes: AcpModeDefinition[] = agentId === 'orchestrator'
    ? ['quick', 'precision', 'auto'].map((id) => fallbackMode(agentId, id, id === 'auto'))
    : ['base', 'scope', 'spec', 'exec'].map((id, index) => fallbackMode(agentId, id, index === 0));
  const defaultMode = fallbackModes.find((mode) => mode.default) ?? fallbackModes[0];
  return {
    agentId,
    modes: fallbackModes,
    defaultModeId: defaultMode.id,
    models: models.length > 0 ? models : [defaultModelId],
    defaultModelId,
  };
}

function fallbackMode(agentId: AcpRuntimeAgentId, id: string, isDefault: boolean): AcpModeDefinition {
  const harnessModeId = `${agentId}.${id}`;
  const prompt = fallbackModePrompt(agentId, id);
  return {
    id,
    name: `${agentId === 'supervisor' ? 'Supervisor Lead' : 'Orchestrator'} / ${fallbackModeName(id)}`,
    agentId,
    harnessMode: id,
    harnessModeId,
    default: isDefault,
    prompt: `<harness-mode id="${harnessModeId}" agent="${agentId}" mode="${id}">\n${prompt}\n</harness-mode>`,
  };
}

function fallbackModeName(id: string): string {
  return {
    base: 'Base',
    scope: 'Scope',
    spec: 'Spec',
    exec: 'Execution',
    quick: 'Quick',
    precision: 'Precision',
    auto: 'Auto',
  }[id] ?? id;
}

function fallbackModePrompt(agentId: AcpRuntimeAgentId, id: string): string {
  if (agentId === 'orchestrator') {
    return {
      quick: 'Agent: Orchestrator\nMode: Quick',
      precision: 'Agent: Orchestrator\nMode: Precision',
      auto: 'Agent: Orchestrator\nMode: Auto',
    }[id] ?? `Agent: Orchestrator\nMode: ${id}`;
  }

  const prompts: Record<string, string> = {
    base: 'Agent: Supervisor Lead\nMode: Base\nSupervisor Lead Base:\n- Orchestrate the work pragmatically across scoping, planning, building, and verification.\n- Delegate only when a specialist can advance a bounded part of the task.\n- Keep ownership of the final answer, evidence quality, and next action.',
    scope: 'Agent: Supervisor Lead\nMode: Scope\nSupervisor Lead Scope:\n- Identify the smallest useful slice, non-goals, assumptions, and evidence needed.\n- Route discovery to the right specialist before committing to implementation.\n- Stop for a decision when product scope or write boundaries are unclear.',
    spec: 'Agent: Supervisor Lead\nMode: Spec\nSupervisor Lead Spec:\n- Convert the scoped slice into a concrete execution plan with boundaries and verification.\n- Use specialists to sharpen contracts, risks, and acceptance criteria.\n- Do not present implementation as complete while still planning.',
    exec: 'Agent: Supervisor Lead\nMode: Execution\nSupervisor Lead Exec:\n- Drive implementation through the appropriate specialist agents while preserving the approved boundary.\n- Keep build progress tied to concrete files, behavior, and evidence.\n- Escalate if implementation requires a new scope or architecture decision.\n- Audit the completed or claimed work before final synthesis.\n- Require evidence from tests, inspected diffs, snapshot turn/session diffs, tool output, or explicit verification gaps.\n- When a specialist claims it changed code, require snapshot-backed audit evidence unless snapshots are unavailable and that gap is stated.\n- Separate confirmed results from residual risk.',
  };
  return prompts[id] ?? `Agent: Supervisor Lead\nMode: ${id}`;
}

function configuredModelEnvValues(agentId: AcpRuntimeAgentId): string[] {
  const agentSpecificKeys = agentId === 'orchestrator'
    ? ['MASTRA_ORCHESTRATE_MODEL', 'MASTRA_CODE_MODEL']
    : ['MASTRA_SUPERVISOR_MODEL'];
  return unique([
    ...agentSpecificKeys.map((key) => process.env[key]),
    process.env.MASTRA_AGENT_MODEL,
    process.env.MASTRA_SUBAGENT_MODEL,
    process.env.MASTRA_MODEL,
  ]);
}

function unique(values: Array<string | undefined>): string[] {
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index);
}
