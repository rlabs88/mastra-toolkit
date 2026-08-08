import {
  browserActionRequiresApproval,
  createDynamicWorkflowTool,
  createRunBudgetHooks,
  createToolAuditHooks,
  createVisibleBrowser,
  reconcileDynamicWorkflowDefinitions,
  RUN_CONTAINMENT_POLICY,
} from "@rlabs/agent-tools";
import {
  composePrompt,
  createToolkitAgentRegistry,
  createToolkitAgents,
  ROLE_IDS,
  ROLES,
  TOOLKIT_WORKSPACE_CONTEXT_KEY,
  type RoleId,
} from "@rlabs/agents-roles";
import { ProjectMountingManager } from "@rlabs/project-mounting-manager";
import {
  AGENT_BACKGROUND_TASK_POLICY,
  HOST_BACKGROUND_TASK_POLICY,
  resolveRuntimeDefaultsV1,
  type ModelProfile,
} from "@rlabs/runtime-config";
import { createHash } from "node:crypto";
import { createSandboxMachine } from "@rlabs/sandbox";

export const TOOLKIT_RUNTIME_CONTRACT_VERSION = 3 as const;
const TOOLKIT_RUNTIME_CAPABILITY_SCHEMA_VERSION = 3 as const;

export interface ToolkitRuntimeIdentity {
  readonly projectId: string;
  readonly userId: string;
  readonly sessionId: string;
}

export interface ToolkitRuntimeResolver<T> {
  resolve(context?: unknown): T | Promise<T>;
}

export interface ToolkitRuntimeBinding<TWorkspace = unknown, TSandbox = unknown> {
  readonly identity: ToolkitRuntimeIdentity | ToolkitRuntimeResolver<ToolkitRuntimeIdentity>;
  readonly workspace: ToolkitRuntimeResolver<TWorkspace>;
  readonly sandbox: ToolkitRuntimeResolver<TSandbox>;
  readonly browser?: { readonly implementation: unknown };
  readonly approval: { readonly context: unknown };
}

export interface ToolkitRuntimeContractOptions {
  readonly profile: ModelProfile;
  readonly providerBaseUrl?: string;
}

export interface ToolkitRuntimeCapabilityDescriptorV3 {
  readonly schemaVersion: typeof TOOLKIT_RUNTIME_CAPABILITY_SCHEMA_VERSION;
  readonly contractVersion: typeof TOOLKIT_RUNTIME_CONTRACT_VERSION;
  // Derived from the canonical role registry, never a literal tuple: a
  // descriptor that silently accepts a further role while claiming to describe
  // three would make the digest look right while being wrong.
  readonly roles: typeof ROLE_IDS;
  readonly roleInstructionDigests: Readonly<Record<RoleId, `sha256:${string}`>>;
  readonly roleModels: Readonly<Record<RoleId, string>>;
  readonly roleMaxSteps: Readonly<Record<RoleId, number>>;
  readonly roleTemperatures: Readonly<Record<RoleId, number>>;
  readonly tools: {
    readonly agentVisible: {
      readonly workspace: "mastra-workspace-tools/v1";
      readonly dynamicWorkflow: "dynamic-workflow/v1";
    };
    readonly audit: "tool-audit/v1";
    readonly runBudget: "run-budget/v1";
    readonly browserApproval: "visible-browser-approval/v1";
  };
  readonly delegation: {
    readonly nativeTool: "subagent";
    readonly targets: typeof ROLE_IDS;
    readonly delegatedLeavesReceiveSubagent: false;
    readonly supervisorSurface: "agents-map";
    readonly supervisorTargets: typeof ROLE_IDS;
    readonly supervisorLeavesReceiveAgents: false;
  };
  readonly containment: typeof RUN_CONTAINMENT_POLICY;
  readonly runtime: {
    readonly providerId: string;
    readonly providerBaseUrl: string;
    readonly providerApiKeyEnv: string;
    readonly aliases: readonly string[];
    readonly defaults: ReturnType<typeof resolveRuntimeDefaultsV1>;
    readonly backgroundTasks: {
      readonly host: typeof HOST_BACKGROUND_TASK_POLICY;
      readonly agent: typeof AGENT_BACKGROUND_TASK_POLICY;
    };
  };
  readonly sandbox: {
    readonly machineContract: "cloneable-sandbox-machine/v1";
    readonly commandExecution: "workspace-sandbox";
  };
  readonly workspace: {
    readonly resolution: "host-binding";
    readonly projectResources: "project-mounting-manager";
    readonly contextKey: typeof TOOLKIT_WORKSPACE_CONTEXT_KEY;
  };
  readonly digest: `sha256:${string}`;
}

export interface ToolkitRuntimeContract {
  readonly version: typeof TOOLKIT_RUNTIME_CONTRACT_VERSION;
  readonly roles: {
    readonly ids: typeof ROLE_IDS;
    readonly definitions: typeof ROLES;
    readonly composePrompt: typeof composePrompt;
    readonly createAgentRegistry: typeof createToolkitAgentRegistry;
    readonly createAgents: typeof createToolkitAgents;
  };
  readonly tools: {
    readonly agentVisible: ToolkitRuntimeCapabilityDescriptorV3["tools"]["agentVisible"];
    readonly dynamicWorkflow: "dynamic-workflow/v1";
    readonly createDynamicWorkflow: typeof createDynamicWorkflowTool;
    readonly reconcileDynamicWorkflowDefinitions: typeof reconcileDynamicWorkflowDefinitions;
    readonly createRunBudgetHooks: typeof createRunBudgetHooks;
    readonly createToolAuditHooks: typeof createToolAuditHooks;
    readonly createVisibleBrowser: typeof createVisibleBrowser;
    readonly browserActionRequiresApproval: typeof browserActionRequiresApproval;
  };
  readonly delegation: ToolkitRuntimeCapabilityDescriptorV3["delegation"];
  readonly containment: typeof RUN_CONTAINMENT_POLICY;
  readonly runtime: {
    readonly profile: ModelProfile;
    readonly defaults: ReturnType<typeof resolveRuntimeDefaultsV1>;
    readonly hostBackgroundTasks: typeof HOST_BACKGROUND_TASK_POLICY;
    readonly agentBackgroundTasks: typeof AGENT_BACKGROUND_TASK_POLICY;
  };
  readonly sandbox: {
    readonly createMachine: typeof createSandboxMachine;
  };
  readonly workspace: {
    readonly contextKey: typeof TOOLKIT_WORKSPACE_CONTEXT_KEY;
    readonly ProjectMountingManager: typeof ProjectMountingManager;
  };
  readonly capability: ToolkitRuntimeCapabilityDescriptorV3;
}

/** @deprecated Runtime contract v2 predates dynamic_workflow. */
export type ToolkitRuntimeCapabilityDescriptorV2 = ToolkitRuntimeCapabilityDescriptorV3;

export function createToolkitRuntimeContract(
  options: ToolkitRuntimeContractOptions,
): ToolkitRuntimeContract {
  const profile = deepFreeze(structuredClone(options.profile));
  const providerBaseUrl = options.providerBaseUrl ?? profile.provider.baseUrl;
  assertCredentialFreeProviderUrl(profile.provider.baseUrl);
  assertCredentialFreeProviderUrl(providerBaseUrl);
  const defaults = resolveRuntimeDefaultsV1(profile);
  const delegation = deepFreeze({
    nativeTool: "subagent",
    targets: ROLE_IDS,
    delegatedLeavesReceiveSubagent: false,
    supervisorSurface: "agents-map",
    supervisorTargets: ROLE_IDS,
    supervisorLeavesReceiveAgents: false,
  } as const);
  const payload = {
    schemaVersion: TOOLKIT_RUNTIME_CAPABILITY_SCHEMA_VERSION,
    contractVersion: TOOLKIT_RUNTIME_CONTRACT_VERSION,
    roles: ROLE_IDS,
    roleInstructionDigests: mapRoles(id => digest(composePrompt(ROLES[id]))),
    roleModels: mapRoles(id => defaults.models.roles[id].gatewayModelId),
    roleMaxSteps: mapRoles(id => ROLES[id].model.steps),
    roleTemperatures: mapRoles(id => ROLES[id].model.temperature),
    tools: {
      agentVisible: {
        workspace: "mastra-workspace-tools/v1",
        dynamicWorkflow: "dynamic-workflow/v1",
      },
      audit: "tool-audit/v1",
      runBudget: "run-budget/v1",
      browserApproval: "visible-browser-approval/v1",
    },
    delegation,
    containment: RUN_CONTAINMENT_POLICY,
    runtime: {
      providerId: profile.provider.id,
      providerBaseUrl,
      providerApiKeyEnv: profile.provider.apiKeyEnv,
      aliases: [...profile.aliases],
      defaults,
      backgroundTasks: {
        host: HOST_BACKGROUND_TASK_POLICY,
        agent: AGENT_BACKGROUND_TASK_POLICY,
      },
    },
    sandbox: {
      machineContract: "cloneable-sandbox-machine/v1",
      commandExecution: "workspace-sandbox",
    },
    workspace: {
      resolution: "host-binding",
      projectResources: "project-mounting-manager",
      contextKey: TOOLKIT_WORKSPACE_CONTEXT_KEY,
    },
  } as const;
  const capability = deepFreeze({
    ...payload,
    digest: digest(stableJson(payload)),
  }) as ToolkitRuntimeCapabilityDescriptorV2;

  return deepFreeze({
    version: TOOLKIT_RUNTIME_CONTRACT_VERSION,
    roles: {
      ids: ROLE_IDS,
      definitions: ROLES,
      composePrompt,
      createAgentRegistry: createToolkitAgentRegistry,
      createAgents: createToolkitAgents,
    },
    tools: {
      agentVisible: capability.tools.agentVisible,
      dynamicWorkflow: "dynamic-workflow/v1",
      createDynamicWorkflow: createDynamicWorkflowTool,
      reconcileDynamicWorkflowDefinitions,
      createRunBudgetHooks,
      createToolAuditHooks,
      createVisibleBrowser,
      browserActionRequiresApproval,
    },
    delegation,
    containment: RUN_CONTAINMENT_POLICY,
    runtime: {
      profile,
      defaults,
      hostBackgroundTasks: HOST_BACKGROUND_TASK_POLICY,
      agentBackgroundTasks: AGENT_BACKGROUND_TASK_POLICY,
    },
    sandbox: {
      createMachine: createSandboxMachine,
    },
    workspace: {
      contextKey: TOOLKIT_WORKSPACE_CONTEXT_KEY,
      ProjectMountingManager,
    },
    capability,
  });
}

function assertCredentialFreeProviderUrl(value: string): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Runtime provider baseUrl must not contain credentials, query parameters, or fragments");
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

export function verifyToolkitRuntimeCapability(
  contract: ToolkitRuntimeContract,
  capability: ToolkitRuntimeCapabilityDescriptorV2 | string,
): boolean {
  if (typeof capability === "string") return capability === contract.capability.digest;
  const { digest: candidateDigest, ...payload } = capability;
  return candidateDigest === contract.capability.digest
    && digest(stableJson(payload)) === candidateDigest;
}

function mapRoles<T>(select: (id: (typeof ROLE_IDS)[number]) => T): Record<(typeof ROLE_IDS)[number], T> {
  return Object.fromEntries(ROLE_IDS.map(id => [id, select(id)])) as Record<(typeof ROLE_IDS)[number], T>;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
