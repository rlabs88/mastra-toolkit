import { orchestratorModePrompts } from "../prompts/agents/orchestrator.js";
import { supervisorModePrompts } from "../prompts/agents/supervisor.js";
import { sharedAgentModeNames, type AgentModePromptMap, type SharedAgentModeId } from "./shared.js";

export const REQUEST_CONTEXT_HARNESS_MODE_KEY = "harnessMode";
export const REQUEST_CONTEXT_HARNESS_MODE_ID_KEY = "harnessModeId";
export const REQUEST_CONTEXT_ACTIVE_AGENT_ID_KEY = "activeAgentId";
export const REQUEST_CONTEXT_LAST_SUBMITTED_HARNESS_MODE_ID_KEY = "lastSubmittedHarnessModeId";
export const REQUEST_CONTEXT_HARDNESS_MODE_KEY = "hardnessMode";

export type MastraAgentHarnessAgentId = "orchestrator" | "supervisor";
export type SupervisorScopeId = "base" | "scope" | "spec" | "exec";
export type OrchestratorModeId = "quick" | "precision" | "auto";
export type MastraAgentHarnessLocalModeId = SupervisorScopeId | OrchestratorModeId;

export type MastraAgentHarnessModeId =
  | `supervisor.${SupervisorScopeId}`
  | `orchestrator.${OrchestratorModeId}`;

export type MastraAgentHarnessState = {
  activeAgentId?: MastraAgentHarnessAgentId;
  supervisorScope?: SupervisorScopeId;
  orchestratorMode?: OrchestratorModeId;
  modelId?: string;
  workspaceSettings?: Record<string, unknown>;
  toolSettings?: Record<string, unknown>;
  runtimeSettings?: Record<string, unknown>;
  harnessMode?: MastraAgentHarnessLocalModeId;
  harnessModeId?: MastraAgentHarnessModeId;
  lastSubmittedHarnessModeId?: MastraAgentHarnessModeId;
  /** @deprecated Use harnessMode or harnessModeId. */
  hardnessMode?: string;
};

type AgentModeDefinition = {
  agentId: MastraAgentHarnessAgentId;
  agentName: string;
  modePrompts: AgentModePromptMap;
};

export type ResolvedMastraAgentHarnessMode = {
  activeAgentId: MastraAgentHarnessAgentId;
  agentName: string;
  harnessMode: MastraAgentHarnessLocalModeId;
  supervisorScope?: SupervisorScopeId;
  orchestratorMode?: OrchestratorModeId;
  harnessModeName: string;
  harnessModeId: MastraAgentHarnessModeId;
  modePrompt: string;
};

export type MastraAgentHarnessModeSpec = {
  id: MastraAgentHarnessModeId;
  agentId: MastraAgentHarnessAgentId;
  harnessMode: MastraAgentHarnessLocalModeId;
  name: string;
  default: boolean;
  color: string;
};

export const DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID = "orchestrator" satisfies MastraAgentHarnessAgentId;
export const DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE = "auto" satisfies OrchestratorModeId;
export const DEFAULT_MASTRA_AGENT_HARNESS_MODE_ID =
  `${DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID}.${DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE}` as const;

export const mastraAgentModeDefinitions = {
  orchestrator: {
    agentId: "orchestrator",
    agentName: "Orchestrator",
    modePrompts: orchestratorModePrompts,
  },
  supervisor: {
    agentId: "supervisor",
    agentName: "Supervisor Lead",
    modePrompts: supervisorModePrompts,
  },
} as const satisfies Record<MastraAgentHarnessAgentId, AgentModeDefinition>;

const agentAliasToAgentId = new Map<string, MastraAgentHarnessAgentId>([
  ["orchestrator", "orchestrator"],
  ["orchestrator-agent", "orchestrator"],
  ["orchestratoragent", "orchestrator"],
  ["supervisor", "supervisor"],
  ["supervisor-agent", "supervisor"],
  ["supervisoragent", "supervisor"],
  ["supervisor-lead", "supervisor"],
  ["supervisorlead", "supervisor"],
]);

const supervisorScopeAliases = new Map<string, SupervisorScopeId>([
  ["base", "base"],
  ["balance", "base"],
  ["balanced", "base"],
  ["scope", "scope"],
  ["spec", "spec"],
  ["plan", "spec"],
  ["exec", "exec"],
  ["execution", "exec"],
  ["build", "exec"],
  ["verify", "exec"],
]);

const orchestratorModeAliases = new Map<string, OrchestratorModeId>([
  ["quick", "quick"],
  ["precision", "precision"],
  ["precise", "precision"],
  ["auto", "auto"],
  ["balanced", "auto"],
  ["balance", "auto"],
  ["build", "auto"],
  ["scope", "precision"],
  ["plan", "precision"],
  ["verify", "precision"],
]);

export const mastraAgentHarnessModeSpecs: MastraAgentHarnessModeSpec[] = Object.values(mastraAgentModeDefinitions).flatMap(
  (definition) =>
    Object.entries(definition.modePrompts).map(([modeId]) => {
      const harnessMode = modeId as MastraAgentHarnessLocalModeId;
      const compositeModeId = `${definition.agentId}.${harnessMode}` as MastraAgentHarnessModeId;
      return {
        id: compositeModeId,
        agentId: definition.agentId,
        harnessMode,
        name: `${definition.agentName} / ${sharedAgentModeNames[harnessMode]}`,
        default: compositeModeId === DEFAULT_MASTRA_AGENT_HARNESS_MODE_ID,
        color: harnessModeColor(harnessMode),
      };
    }),
);

const defaultModeId = (mastraAgentHarnessModeSpecs.find((mode) => mode.default) ?? mastraAgentHarnessModeSpecs[0]).id;

export function defaultMastraAgentHarnessModeId(): MastraAgentHarnessModeId {
  return defaultModeId;
}

export function isMastraAgentHarnessModeId(value: unknown): value is MastraAgentHarnessModeId {
  return typeof value === "string" && mastraAgentHarnessModeSpecs.some((mode) => mode.id === value);
}

export function resolveMastraAgentHarnessMode({
  agentId,
  harnessMode,
  hardnessMode,
}: {
  agentId?: string;
  harnessMode?: string;
  /** @deprecated Use harnessMode. */
  hardnessMode?: string;
}): ResolvedMastraAgentHarnessMode {
  const requestedHarnessMode = cleanInput(harnessMode);
  const requestedDeprecatedHardnessMode = cleanInput(hardnessMode);
  const requestedMode = requestedHarnessMode ?? requestedDeprecatedHardnessMode;

  if (requestedMode) {
    const compositeModeId = parseCompositeModeId(requestedMode);
    if (compositeModeId) {
      return resolvedModeFromId(compositeModeId);
    }

    const activeAgentId = resolveAgentId(agentId) ?? DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID;
    const localModeId = resolveLocalModeId(requestedMode, activeAgentId);
    if (localModeId) {
      return resolvedMode(activeAgentId, localModeId);
    }

    if (!requestedHarnessMode) {
      const legacyAgentId = resolveAgentId(requestedMode);
      if (legacyAgentId) {
        return resolvedMode(legacyAgentId, defaultLocalModeForAgent(legacyAgentId));
      }
    }

    throw new Error(
      `Unknown harness mode "${requestedMode}". Expected a local mode (${allLocalModeIds().join(", ")}) or composite mode (${mastraAgentHarnessModeSpecs.map((mode) => mode.id).join(", ")}).`,
    );
  }

  const activeAgentId = resolveAgentId(agentId);
  if (!activeAgentId && agentId) {
    throw new Error(`Unknown agentId "${agentId}". Expected one of: ${Object.keys(mastraAgentModeDefinitions).join(", ")}`);
  }

  const resolvedAgentId = activeAgentId ?? DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID;
  return resolvedMode(resolvedAgentId, defaultLocalModeForAgent(resolvedAgentId));
}

export function resolveMastraAgentHarnessModeId({
  agentId,
  harnessMode,
  hardnessMode,
}: {
  agentId?: string;
  harnessMode?: string;
  /** @deprecated Use harnessMode. */
  hardnessMode?: string;
}): MastraAgentHarnessModeId {
  return resolveMastraAgentHarnessMode({ agentId, harnessMode, hardnessMode }).harnessModeId;
}

export function formatMastraAgentHarnessModePrompt(resolved: ResolvedMastraAgentHarnessMode): string {
  return [
    `<harness-mode id="${resolved.harnessModeId}" agent="${resolved.activeAgentId}" mode="${resolved.harnessMode}">`,
    `Agent: ${resolved.agentName}`,
    `Mode: ${resolved.harnessModeName}`,
    resolved.modePrompt.trim(),
    `</harness-mode>`,
  ].join("\n");
}

function resolvedMode(activeAgentId: MastraAgentHarnessAgentId, harnessMode: MastraAgentHarnessLocalModeId): ResolvedMastraAgentHarnessMode {
  const definition = mastraAgentModeDefinitions[activeAgentId];
  const modePrompts = definition.modePrompts as AgentModePromptMap;
  const modePrompt = modePrompts[harnessMode];
  if (!modePrompt) {
    const expected = Object.keys(modePrompts).join(", ");
    throw new Error(`Agent "${activeAgentId}" does not support harness mode "${harnessMode}". Expected one of: ${expected}`);
  }
  return {
    activeAgentId,
    agentName: definition.agentName,
    harnessMode,
    supervisorScope: activeAgentId === "supervisor" ? harnessMode as SupervisorScopeId : undefined,
    orchestratorMode: activeAgentId === "orchestrator" ? harnessMode as OrchestratorModeId : undefined,
    harnessModeName: sharedAgentModeNames[harnessMode],
    harnessModeId: `${activeAgentId}.${harnessMode}` as MastraAgentHarnessModeId,
    modePrompt,
  };
}

function resolvedModeFromId(harnessModeId: MastraAgentHarnessModeId): ResolvedMastraAgentHarnessMode {
  const [agentId, localModeId] = harnessModeId.split(".") as [MastraAgentHarnessAgentId, MastraAgentHarnessLocalModeId];
  return resolvedMode(agentId, localModeId);
}

function parseCompositeModeId(value: string): MastraAgentHarnessModeId | undefined {
  const [agentPart, modePart, extra] = value.toLowerCase().replace(/_/g, "-").split(".");
  if (!agentPart || !modePart || extra) return undefined;
  const agentId = resolveAgentId(agentPart);
  const modeId = agentId ? resolveLocalModeId(modePart, agentId) : undefined;
  if (!agentId || !modeId) return undefined;
  const harnessModeId = `${agentId}.${modeId}` as MastraAgentHarnessModeId;
  return isMastraAgentHarnessModeId(harnessModeId) ? harnessModeId : undefined;
}

function resolveAgentId(value: string | undefined): MastraAgentHarnessAgentId | undefined {
  const normalized = normalizeAlias(value);
  return normalized ? agentAliasToAgentId.get(normalized) : undefined;
}

function resolveLocalModeId(value: string, agentId: MastraAgentHarnessAgentId): MastraAgentHarnessLocalModeId | undefined {
  const normalized = normalizeAlias(value);
  return agentId === "supervisor" ? supervisorScopeAliases.get(normalized) : orchestratorModeAliases.get(normalized);
}

function defaultLocalModeForAgent(agentId: MastraAgentHarnessAgentId): MastraAgentHarnessLocalModeId {
  return agentId === "supervisor" ? "base" : DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE;
}

function cleanInput(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function normalizeAlias(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/_/g, "-") ?? "";
}

function allLocalModeIds(): MastraAgentHarnessLocalModeId[] {
  return Array.from(new Set(Object.values(mastraAgentModeDefinitions).flatMap((definition) => Object.keys(definition.modePrompts)))) as MastraAgentHarnessLocalModeId[];
}

function harnessModeColor(modeId: SharedAgentModeId): string {
  switch (modeId) {
    case "base":
    case "balanced":
      return "#2563eb";
    case "scope":
      return "#0891b2";
    case "spec":
    case "plan":
      return "#7c3aed";
    case "exec":
    case "build":
      return "#16a34a";
    case "quick":
      return "#0d9488";
    case "precision":
      return "#7c2d12";
    case "auto":
      return "#2563eb";
    case "verify":
    case "test":
      return "#0f766e";
    case "research":
      return "#4f46e5";
    case "brainstorm":
      return "#d97706";
    case "analysis":
      return "#9333ea";
    case "audit":
      return "#dc2626";
    case "debug":
      return "#ea580c";
  }
}
