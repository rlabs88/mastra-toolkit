import { Harness, type HarnessMode } from "@mastra/core/harness";

import { advisorModePrompts } from "../prompts/agents/advisor.js";
import { architectModePrompts } from "../prompts/agents/architect.js";
import { developerModePrompts } from "../prompts/agents/developer.js";
import { researcherModePrompts } from "../prompts/agents/researcher.js";
import { scoutModePrompts } from "../prompts/agents/scout.js";
import { orchestratorModePrompts } from "../prompts/agents/orchestrator.js";
import { supervisorModePrompts } from "../prompts/agents/supervisor.js";
import { validatorModePrompts } from "../prompts/agents/validator.js";
import { advisorAgent } from "./advisor-agent.js";
import { orchestratorAgent } from "./orchestrator-agent.js";
import { architectAgent } from "./architect-agent.js";
import { developerAgent } from "./developer-agent.js";
import { researcherAgent } from "./researcher-agent.js";
import { scoutAgent } from "./scout-agent.js";
import { sharedAgentModeNames, type AgentModePromptMap, type SharedAgentModeId } from "./shared.js";
import { supervisorAgent } from "./agent.js";
import { validatorAgent } from "./validator-agent.js";

export const REQUEST_CONTEXT_HARNESS_MODE_KEY = "harnessMode";
export const REQUEST_CONTEXT_HARNESS_MODE_ID_KEY = "harnessModeId";
export const REQUEST_CONTEXT_ACTIVE_AGENT_ID_KEY = "activeAgentId";
export const REQUEST_CONTEXT_LAST_SUBMITTED_HARNESS_MODE_ID_KEY = "lastSubmittedHarnessModeId";
export const REQUEST_CONTEXT_HARDNESS_MODE_KEY = "hardnessMode";

export type MastraAgentHarnessAgentId =
  | "orchestrator"
  | "supervisor"
  | "scout"
  | "researcher"
  | "architect"
  | "advisor"
  | "developer"
  | "validator";

export type MastraAgentHarnessModeId = `${MastraAgentHarnessAgentId}.${SharedAgentModeId}`;

export type MastraAgentHarnessState = {
  activeAgentId?: MastraAgentHarnessAgentId;
  harnessMode?: SharedAgentModeId;
  harnessModeId?: MastraAgentHarnessModeId;
  lastSubmittedHarnessModeId?: MastraAgentHarnessModeId;
  /** @deprecated Use harnessMode or harnessModeId. */
  hardnessMode?: string;
};

type AgentModeDefinition = {
  agentId: MastraAgentHarnessAgentId;
  agentName: string;
  modePrompts: AgentModePromptMap;
  agent: HarnessMode<MastraAgentHarnessState>["agent"];
};

export type ResolvedMastraAgentHarnessMode = {
  activeAgentId: MastraAgentHarnessAgentId;
  agentName: string;
  harnessMode: SharedAgentModeId;
  harnessModeName: string;
  harnessModeId: MastraAgentHarnessModeId;
  modePrompt: string;
};

export const DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID = "orchestrator" satisfies MastraAgentHarnessAgentId;
export const DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE = "balanced" satisfies SharedAgentModeId;
export const DEFAULT_MASTRA_AGENT_HARNESS_MODE_ID =
  `${DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID}.${DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE}` as const;

export const mastraAgentModeDefinitions = {
  orchestrator: {
    agentId: "orchestrator",
    agentName: "Orchestrator",
    modePrompts: orchestratorModePrompts,
    agent: orchestratorAgent,
  },
  supervisor: {
    agentId: "supervisor",
    agentName: "Supervisor Lead",
    modePrompts: supervisorModePrompts,
    agent: supervisorAgent,
  },
  scout: {
    agentId: "scout",
    agentName: "Scout",
    modePrompts: scoutModePrompts,
    agent: scoutAgent,
  },
  researcher: {
    agentId: "researcher",
    agentName: "Researcher",
    modePrompts: researcherModePrompts,
    agent: researcherAgent,
  },
  architect: {
    agentId: "architect",
    agentName: "Architect",
    modePrompts: architectModePrompts,
    agent: architectAgent,
  },
  advisor: {
    agentId: "advisor",
    agentName: "Advisor",
    modePrompts: advisorModePrompts,
    agent: advisorAgent,
  },
  developer: {
    agentId: "developer",
    agentName: "Developer",
    modePrompts: developerModePrompts,
    agent: developerAgent,
  },
  validator: {
    agentId: "validator",
    agentName: "Validator",
    modePrompts: validatorModePrompts,
    agent: validatorAgent,
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
  ["scout", "scout"],
  ["scout-agent", "scout"],
  ["scoutagent", "scout"],
  ["researcher", "researcher"],
  ["researcher-agent", "researcher"],
  ["researcheragent", "researcher"],
  ["architect", "architect"],
  ["architect-agent", "architect"],
  ["architectagent", "architect"],
  ["advisor", "advisor"],
  ["advisor-agent", "advisor"],
  ["advisoragent", "advisor"],
  ["developer", "developer"],
  ["developer-agent", "developer"],
  ["developeragent", "developer"],
  ["validator", "validator"],
  ["validator-agent", "validator"],
  ["validatoragent", "validator"],
]);

const localModeAliases = new Map<string, SharedAgentModeId>([
  ["balance", "balanced"],
  ["balanced", "balanced"],
  ["scope", "scope"],
  ["plan", "plan"],
  ["build", "build"],
  ["verify", "verify"],
  ["research", "research"],
  ["brainstorm", "brainstorm"],
  ["analysis", "analysis"],
  ["analyze", "analysis"],
  ["analyse", "analysis"],
  ["test", "test"],
  ["audit", "audit"],
  ["debug", "debug"],
]);

export const mastraAgentHarnessModes: HarnessMode<MastraAgentHarnessState>[] = Object.values(mastraAgentModeDefinitions).flatMap(
  (definition) =>
    Object.entries(definition.modePrompts).map(([modeId]) => {
      const harnessMode = modeId as SharedAgentModeId;
      const compositeModeId = `${definition.agentId}.${harnessMode}` as MastraAgentHarnessModeId;
      return {
        id: compositeModeId,
        name: `${definition.agentName} / ${sharedAgentModeNames[harnessMode]}`,
        default: compositeModeId === DEFAULT_MASTRA_AGENT_HARNESS_MODE_ID,
        agent: definition.agent,
        color: harnessModeColor(harnessMode),
      };
    }),
);

const defaultModeId = (mastraAgentHarnessModes.find((mode) => mode.default) ?? mastraAgentHarnessModes[0]).id as MastraAgentHarnessModeId;

export function defaultMastraAgentHarnessModeId(): MastraAgentHarnessModeId {
  return defaultModeId;
}

export function isMastraAgentHarnessModeId(value: unknown): value is MastraAgentHarnessModeId {
  return typeof value === "string" && mastraAgentHarnessModes.some((mode) => mode.id === value);
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

    const localModeId = resolveLocalModeId(requestedMode);
    if (localModeId) {
      const activeAgentId = resolveAgentId(agentId) ?? DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID;
      return resolvedMode(activeAgentId, localModeId);
    }

    if (!requestedHarnessMode) {
      const legacyAgentId = resolveAgentId(requestedMode);
      if (legacyAgentId) {
        return resolvedMode(legacyAgentId, DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE);
      }
    }

    throw new Error(
      `Unknown harness mode "${requestedMode}". Expected a local mode (${allLocalModeIds().join(", ")}) or composite mode (${mastraAgentHarnessModes.map((mode) => mode.id).join(", ")}).`,
    );
  }

  const activeAgentId = resolveAgentId(agentId);
  if (!activeAgentId && agentId) {
    throw new Error(`Unknown agentId "${agentId}". Expected one of: ${Object.keys(mastraAgentModeDefinitions).join(", ")}`);
  }

  return resolvedMode(activeAgentId ?? DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID, DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE);
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

export function createMastraAgentHarness(): Harness<MastraAgentHarnessState> {
  return new Harness<MastraAgentHarnessState>({
    id: "mastra-system-agents",
    initialState: {
      activeAgentId: DEFAULT_MASTRA_AGENT_HARNESS_AGENT_ID,
      harnessMode: DEFAULT_MASTRA_AGENT_HARNESS_LOCAL_MODE,
      harnessModeId: defaultModeId,
      hardnessMode: defaultModeId,
    },
    modes: mastraAgentHarnessModes,
  });
}

export const mastraAgentHarness = createMastraAgentHarness();

function resolvedMode(activeAgentId: MastraAgentHarnessAgentId, harnessMode: SharedAgentModeId): ResolvedMastraAgentHarnessMode {
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
    harnessModeName: sharedAgentModeNames[harnessMode],
    harnessModeId: `${activeAgentId}.${harnessMode}`,
    modePrompt,
  };
}

function resolvedModeFromId(harnessModeId: MastraAgentHarnessModeId): ResolvedMastraAgentHarnessMode {
  const [agentId, localModeId] = harnessModeId.split(".") as [MastraAgentHarnessAgentId, SharedAgentModeId];
  return resolvedMode(agentId, localModeId);
}

function parseCompositeModeId(value: string): MastraAgentHarnessModeId | undefined {
  const [agentPart, modePart, extra] = value.toLowerCase().replace(/_/g, "-").split(".");
  if (!agentPart || !modePart || extra) return undefined;
  const agentId = resolveAgentId(agentPart);
  const modeId = resolveLocalModeId(modePart);
  if (!agentId || !modeId) return undefined;
  const harnessModeId = `${agentId}.${modeId}` as MastraAgentHarnessModeId;
  return isMastraAgentHarnessModeId(harnessModeId) ? harnessModeId : undefined;
}

function resolveAgentId(value: string | undefined): MastraAgentHarnessAgentId | undefined {
  const normalized = normalizeAlias(value);
  return normalized ? agentAliasToAgentId.get(normalized) : undefined;
}

function resolveLocalModeId(value: string): SharedAgentModeId | undefined {
  return localModeAliases.get(normalizeAlias(value));
}

function cleanInput(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function normalizeAlias(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/_/g, "-") ?? "";
}

function allLocalModeIds(): SharedAgentModeId[] {
  return Array.from(new Set(Object.keys(sharedAgentModeNames) as SharedAgentModeId[]));
}

function harnessModeColor(modeId: SharedAgentModeId): string {
  switch (modeId) {
    case "balanced":
      return "#2563eb";
    case "scope":
      return "#0891b2";
    case "plan":
      return "#7c3aed";
    case "build":
      return "#16a34a";
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
