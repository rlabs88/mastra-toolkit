import type { ToolsInput } from "@mastra/core/agent";
import type { AgentControllerMode, AgentControllerSubagent } from "@mastra/core/agent-controller";
import { ROLE_IDS, type RoleId, type ToolkitAgents, type ToolkitAgentsOptions } from "@rlabs/agents-roles";
import {
  createToolkitRuntimeContract,
  type ToolkitRuntimeBinding,
  type ToolkitRuntimeContract,
} from "@rlabs/mastra-primitives-export";
import { DEFAULT_ACTIVE_ALIAS, type ModelProfile, resolveAliasModelId, resolveProxyGatewayModelId } from "@rlabs/runtime-config";
import { createHash } from "node:crypto";

export const buildModePrompt = `# Build mode

Implement the requested project change as a verified vertical slice. Preserve repository policy, approvals, containment, and current user choices. Exercise the complete coding tool surface as needed, validate behavior, and leave concrete evidence.`;

export const scopeModePrompt = `# Scope mode

Establish the project boundary, current evidence, constraints, risks, and the smallest coherent next change. You retain the complete coding tool surface and ordinary approval rules. Use tools whenever they improve the evidence; do not treat this prompt overlay as a read-only boundary.`;

export const CANONICAL_AGENT_IDS = ROLE_IDS;
export const CODE_MODE_NAMES = ["scope", "build"] as const;
export const NATIVE_WORKSPACE_TOOL_IDS = [
  "view",
  "write_file",
  "string_replace_lsp",
  "find_files",
  "search_content",
  "execute_command",
] as const;

/**
 * Tool ids the host owns outright. They are handed to the project mounting
 * manager for shadow detection only; nothing that manager publishes may
 * reintroduce them, because host tools carry role-level exclusions that a
 * project-mounted tool map cannot express.
 */
export const RESERVED_HOST_TOOL_IDS = ["dynamic_workflow"] as const;

/**
 * Capability vocabulary a project specialist may use instead of this host's tool IDs.
 *
 * `.github/agents` is GitHub Copilot's directory, and the agent files there describe their tools as
 * capabilities — `tools: [read, search, edit, execute, agent]` — because Copilot has no notion of
 * `mastra_workspace_read_file`. Those same files are valid project specialists here, and specialist
 * tool selection fails closed, so without this translation any repository carrying Copilot agents
 * takes the whole MCode runtime down at mount with `Unknown tool for specialist ...`.
 *
 * Grouped by what the capability lets an agent *do*, not by tool count: `read` covers inspecting the
 * tree as well as file contents, and `edit` covers creating and rewriting as well as patching. A
 * capability resolves to whichever of its IDs the host actually publishes, so this stays correct as
 * the workspace tool set changes; a name outside this table is still an unknown tool.
 */
export const SPECIALIST_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read: ["mastra_workspace_read_file", "mastra_workspace_list_files", "mastra_workspace_file_stat"],
  search: ["mastra_workspace_grep"],
  edit: [
    "mastra_workspace_edit_file",
    "mastra_workspace_write_file",
    "mastra_workspace_ast_edit",
    "mastra_workspace_mkdir",
  ],
  execute: [
    "mastra_workspace_execute_command",
    "mastra_workspace_get_process_output",
    "mastra_workspace_kill_process",
  ],
  // Recognized but deliberately granted nothing. Delegation is a host concern: `project_specialist`
  // is published to the bridge, never to specialists, so honouring this would let a specialist
  // dispatch specialists. Declaring it empty keeps a Copilot agent mountable while making the
  // no-grant explicit rather than an unknown-tool failure.
  agent: [],
  // Recognized, granted nothing by the host. The workspace tool set is filesystem and process only,
  // so neither capability has a built-in counterpart here. An MCP server may publish tools that do;
  // their IDs are per-server, so a project that wants them names those IDs directly rather than
  // having this table guess. Empty keeps the agent mountable and its absence visible in the prompt.
  web: [],
  todo: [],
});

export type CanonicalAgentId = (typeof CANONICAL_AGENT_IDS)[number];
export type CodeModeId = (typeof CODE_MODE_NAMES)[number];

export interface AgentModeSelection {
  readonly agent: CanonicalAgentId;
  readonly mode: CodeModeId;
}

export const CODE_MODE_IDS = CANONICAL_AGENT_IDS.flatMap(agent =>
  CODE_MODE_NAMES.map(mode => `${agent}/${mode}` as const),
);

const modePrompts = { scope: scopeModePrompt, build: buildModePrompt } as const;

export function createCodeModes(
  agents: ToolkitAgents,
  profile: ModelProfile,
  additionalTools?: ToolsInput,
): AgentControllerMode[] {
  const defaultModelId = resolveAliasModelId(profile, DEFAULT_ACTIVE_ALIAS);
  return CODE_MODE_IDS.map(id => {
    const selection = decodeAgentMode(id);
    return {
      id,
      name: `${capitalize(selection.agent)} · ${capitalize(selection.mode)}`,
      description: `${capitalize(selection.agent)} using the ${selection.mode} prompt overlay`,
      defaultModelId,
      agent: agents[selection.agent],
      instructions: modePrompts[selection.mode],
      metadata: {
        agent: selection.agent,
        mode: selection.mode,
        ...(id === "cortex/build" ? { default: true } : {}),
      },
      ...(additionalTools ? { additionalTools } : {}),
    };
  });
}

export function encodeAgentMode(selection: AgentModeSelection): (typeof CODE_MODE_IDS)[number] {
  return `${selection.agent}/${selection.mode}`;
}

export function decodeAgentMode(value: string): AgentModeSelection {
  const [agent, mode, extra] = value.split("/");
  if (extra || !isCanonicalAgentId(agent) || !isCodeModeId(mode)) {
    throw new Error(`Invalid agent mode: ${value}`);
  }
  return { agent, mode };
}

export function switchAgent(selection: AgentModeSelection, agent: CanonicalAgentId): AgentModeSelection {
  return { agent, mode: selection.mode };
}

export function switchMode(selection: AgentModeSelection, mode: CodeModeId): AgentModeSelection {
  return { agent: selection.agent, mode };
}

function isCanonicalAgentId(value: string | undefined): value is CanonicalAgentId {
  return CANONICAL_AGENT_IDS.some(agent => agent === value);
}

function isCodeModeId(value: string | undefined): value is CodeModeId {
  return CODE_MODE_NAMES.some(mode => mode === value);
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

export function createCodeSubagents(
  contract: ToolkitRuntimeContract,
): AgentControllerSubagent[] {
  const profile = contract.runtime.profile;
  return contract.roles.ids.map(id => {
    const role = contract.roles.definitions[id];
    return {
      id,
      name: role.name,
      description: role.description,
      instructions: contract.roles.composePrompt(role),
      defaultModelId: resolveProxyGatewayModelId(profile, profile.roles[id]),
      maxSteps: role.model.steps,
    };
  });
}

export function fillMissingSubagentModelId(profile: ModelProfile, input: unknown): void {
  if (!input || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  if (typeof record.modelId === "string" && record.modelId.trim()) return;
  if (!isRoleId(record.agentType)) return;
  record.modelId = resolveProxyGatewayModelId(profile, profile.roles[record.agentType]);
}

function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && ROLE_IDS.some(id => id === value);
}

export const MCODE_CONTROLLER_PROJECTION_VERSION = 3 as const;
/** @deprecated Use MCODE_CONTROLLER_PROJECTION_VERSION. */
export const MCODE_RECIPE_VERSION = MCODE_CONTROLLER_PROJECTION_VERSION;
export const MCODE_CAPABILITY_SCHEMA_VERSION = 3 as const;

interface McodeRecipeCompatibilityOptions extends Omit<ToolkitAgentsOptions, "profile" | "dynamicWorkflow"> {
  readonly profile: ModelProfile;
}

/** @deprecated Pass a ToolkitRuntimeContract and ToolkitRuntimeBinding to createMcodeControllerProjection. */
export type McodeRecipeOptions = McodeRecipeCompatibilityOptions;

export interface McodeControllerProjectionOptions
  extends Omit<ToolkitAgentsOptions, "profile" | "dynamicWorkflow"> {}

export interface McodeControllerIngredientsV3 {
  readonly modes: AgentControllerMode[];
  readonly subagents: AgentControllerSubagent[];
}

/**
 * The authority ceilings `dynamic_workflow` is constructed with. Recorded in
 * the capability digest because widening any of them is an authority change:
 * without this, adding `nestedWorkflows` or a fourth dispatchable agent would
 * be invisible to every digest-comparison test.
 */
export interface McodeDynamicWorkflowCeilings {
  readonly toolId: "dynamic_workflow";
  /** Agent ids a graph may dispatch. Derived from the role registry. */
  readonly agents: readonly string[];
  /** Registered workflow ids a graph may nest. Empty means every nested reference fails closed. */
  readonly nestedWorkflows: readonly string[];
  /** Host-owned ids stripped from anything the project mounting bridge republishes. */
  readonly hostReservedToolIds: readonly string[];
}

export interface McodeCapabilityDescriptorV3 {
  readonly schemaVersion: typeof MCODE_CAPABILITY_SCHEMA_VERSION;
  readonly projectionVersion: typeof MCODE_CONTROLLER_PROJECTION_VERSION;
  /** @deprecated Use projectionVersion. */
  readonly recipeVersion: typeof MCODE_RECIPE_VERSION;
  readonly projection: "mcode" | "studio";
  readonly contractDigest: `sha256:${string}`;
  readonly modes: readonly string[];
  readonly subagents: readonly string[];
  readonly requiredTools: typeof NATIVE_WORKSPACE_TOOL_IDS;
  readonly dynamicWorkflow: McodeDynamicWorkflowCeilings;
  readonly behavior: {
    readonly toolContract: "mastra-workspace-tools/v1";
    readonly modeInstructionDigests: Readonly<Record<string, `sha256:${string}`>>;
    readonly subagentInstructionDigests: Readonly<Record<string, `sha256:${string}`>>;
    readonly subagentMaxSteps: Readonly<Record<string, number>>;
  };
  readonly models: {
    readonly providerId: string;
    readonly aliases: readonly string[];
    readonly modeDefaults: Readonly<Record<string, string>>;
    readonly subagentDefaults: Readonly<Record<string, string>>;
  };
  readonly defaults: {
    readonly mode: "cortex/build";
    readonly preserveExplicitSelections: true;
    readonly preferences: {
      readonly yolo: false;
      readonly thinkingLevel: "off";
    };
  };
  readonly sandbox: {
    readonly commandExecution: "workspace-sandbox";
    readonly projectBinding: "project-user-session";
  };
  readonly local: {
    readonly controllerConstruction: "supported";
    readonly repositoryConfiguration: "project-mounting-manager";
  };
  readonly digest: `sha256:${string}`;
}

export interface McodeControllerProjection {
  readonly version: typeof MCODE_CONTROLLER_PROJECTION_VERSION;
  readonly binding: ToolkitRuntimeBinding;
  readonly agents: ToolkitAgents;
  readonly tools: {
    readonly dynamic_workflow: NonNullable<ToolkitAgentsOptions["dynamicWorkflow"]>;
  };
  readonly controller: McodeControllerIngredientsV3;
  readonly capability: McodeCapabilityDescriptorV3;
}

/** @deprecated Use McodeControllerProjection. */
export type McodeRecipeV3 = McodeControllerProjection;
/** @deprecated MCode projection v2 predates dynamic_workflow. */
export type McodeRecipeV2 = McodeRecipeV3;
/** @deprecated Use McodeControllerIngredientsV3. */
export type McodeControllerIngredientsV2 = McodeControllerIngredientsV3;
/** @deprecated Use McodeCapabilityDescriptorV3. */
export type McodeCapabilityDescriptorV2 = McodeCapabilityDescriptorV3;
export type StudioControllerProjection = McodeControllerProjection;

export function createMcodeControllerProjection(
  contract: ToolkitRuntimeContract,
  binding: ToolkitRuntimeBinding,
  options: McodeControllerProjectionOptions,
): McodeControllerProjection {
  return createControllerProjection("mcode", contract, binding, options);
}

export function createStudioControllerProjection(
  contract: ToolkitRuntimeContract,
  binding: ToolkitRuntimeBinding,
  options: McodeControllerProjectionOptions,
): StudioControllerProjection {
  return createControllerProjection("studio", contract, binding, options);
}

function createControllerProjection(
  projection: "mcode" | "studio",
  contract: ToolkitRuntimeContract,
  binding: ToolkitRuntimeBinding,
  options: McodeControllerProjectionOptions,
): McodeControllerProjection {
  // The host owns persistence and allowlists; the canonical role package only
  // decides which roles receive the resulting capability.
  const ceilings = dynamicWorkflowCeilings(contract);
  const dynamicWorkflow = contract.tools.createDynamicWorkflow({ agents: ceilings.agents });
  const agentOptions = {
    ...options,
    dynamicWorkflow,
    profile: contract.runtime.profile,
  };
  const agents = projection === "studio"
    ? contract.roles.createAgentRegistry(agentOptions).supervisors
    : contract.roles.createAgents(agentOptions);
  const modes = createCodeModes(agents, contract.runtime.profile);
  const subagents = createCodeSubagents(contract);
  return {
    version: MCODE_CONTROLLER_PROJECTION_VERSION,
    binding,
    agents,
    tools: { dynamic_workflow: dynamicWorkflow },
    controller: { modes, subagents },
    capability: createMcodeCapabilityDescriptor(
      contract.runtime.profile,
      modes,
      subagents,
      contract.capability.digest,
      projection,
      ceilings,
    ),
  };
}

/**
 * Derived from the role registry rather than a literal role list, so adding a
 * canonical role widens the recorded ceiling and moves the digest with it.
 */
function dynamicWorkflowCeilings(contract: ToolkitRuntimeContract): McodeDynamicWorkflowCeilings {
  return {
    toolId: "dynamic_workflow",
    agents: [...contract.roles.ids],
    // MCode passes no nested-workflow allowlist, so every nested reference
    // fails closed. Wiring project workflows in here is an authority change.
    nestedWorkflows: [],
    hostReservedToolIds: [...RESERVED_HOST_TOOL_IDS],
  };
}

export function createMcodeRecipe(options: McodeRecipeOptions): McodeRecipeV2 {
  const contract = createToolkitRuntimeContract({ profile: options.profile });
  const { profile: _profile, ...projectionOptions } = options;
  return createControllerProjection(
    "mcode",
    contract,
    compatibilityBinding(),
    projectionOptions,
  );
}

export function createMcodeCapabilityDescriptor(
  profile: ModelProfile,
  modes: AgentControllerMode[],
  subagents: AgentControllerSubagent[],
  contractDigest = createToolkitRuntimeContract({ profile }).capability.digest,
  projection: "mcode" | "studio" = "mcode",
  dynamicWorkflow = dynamicWorkflowCeilings(createToolkitRuntimeContract({ profile })),
): McodeCapabilityDescriptorV3 {
  const payload = {
    schemaVersion: MCODE_CAPABILITY_SCHEMA_VERSION,
    projectionVersion: MCODE_CONTROLLER_PROJECTION_VERSION,
    recipeVersion: MCODE_RECIPE_VERSION,
    projection,
    contractDigest,
    modes: modes.map(mode => mode.id),
    subagents: subagents.map(subagent => subagent.id),
    requiredTools: NATIVE_WORKSPACE_TOOL_IDS,
    dynamicWorkflow,
    behavior: {
      toolContract: "mastra-workspace-tools/v1",
      modeInstructionDigests: Object.fromEntries(modes.map(mode => [mode.id, digestInstructions(mode.instructions)])),
      subagentInstructionDigests: Object.fromEntries(subagents.map(subagent => [subagent.id, digestInstructions(subagent.instructions)])),
      subagentMaxSteps: Object.fromEntries(subagents.flatMap(subagent =>
        typeof subagent.maxSteps === "number" ? [[subagent.id, subagent.maxSteps]] : [])),
    },
    models: {
      providerId: profile.provider.id,
      aliases: profile.aliases,
      modeDefaults: Object.fromEntries(modes.flatMap(mode =>
        typeof mode.defaultModelId === "string" ? [[mode.id, mode.defaultModelId]] : [])),
      subagentDefaults: Object.fromEntries(subagents.flatMap(subagent =>
        typeof subagent.defaultModelId === "string" ? [[subagent.id, subagent.defaultModelId]] : [])),
    },
    defaults: {
      mode: "cortex/build",
      preserveExplicitSelections: true,
      preferences: { yolo: false, thinkingLevel: "off" },
    },
    sandbox: {
      commandExecution: "workspace-sandbox",
      projectBinding: "project-user-session",
    },
    local: {
      controllerConstruction: "supported",
      repositoryConfiguration: "project-mounting-manager",
    },
  } as const;
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { ...payload, digest: `sha256:${digest}` };
}

function compatibilityBinding(): ToolkitRuntimeBinding {
  const unavailable = () => {
    throw new Error("The McodeRecipe compatibility alias has no live runtime binding");
  };
  return {
    identity: {
      projectId: "compatibility",
      userId: "compatibility",
      sessionId: "compatibility",
    },
    workspace: { resolve: unavailable },
    sandbox: { resolve: unavailable },
    approval: { context: { compatibility: true } },
  };
}

function digestInstructions(instructions: unknown): `sha256:${string}` {
  if (typeof instructions !== "string") {
    throw new Error("MCode capability instructions must be static strings");
  }
  return `sha256:${createHash("sha256").update(instructions).digest("hex")}`;
}
