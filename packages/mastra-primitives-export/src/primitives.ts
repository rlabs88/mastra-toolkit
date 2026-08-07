import {
  browserActionRequiresApproval,
  createRunBudgetHooks,
  createToolAuditHooks,
  createVisibleBrowser,
  RUN_CONTAINMENT_POLICY,
} from "@rlabs/agent-tools";
import {
  composePrompt,
  createToolkitAgents,
  ROLE_IDS,
  ROLES,
  TOOLKIT_WORKSPACE_CONTEXT_KEY,
} from "@rlabs/agents-roles";
import { ProjectMountingManager } from "@rlabs/project-mounting-manager";
import {
  AGENT_BACKGROUND_TASK_POLICY,
  HOST_BACKGROUND_TASK_POLICY,
  resolveRuntimeDefaultsV1,
  type ModelProfile,
} from "@rlabs/runtime-config";
import { createHash } from "node:crypto";
import {
  createSandboxCommandRunTool,
  createSandboxMachine,
} from "@rlabs/sandbox";

export const TOOLKIT_RUNTIME_CONTRACT_VERSION = 1 as const;
const TOOLKIT_RUNTIME_CAPABILITY_SCHEMA_VERSION = 1 as const;

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
  readonly commandExecution: {
    authorize(context?: {
      readonly requestContext?: unknown;
      readonly workspace?: TWorkspace;
    }): void | Promise<void>;
  };
  readonly browser?: { readonly implementation: unknown };
  readonly approval: { readonly context: unknown };
}

export interface ToolkitRuntimeContractOptions {
  readonly profile: ModelProfile;
  readonly providerBaseUrl?: string;
}

export interface ToolkitRuntimeCapabilityDescriptorV1 {
  readonly schemaVersion: typeof TOOLKIT_RUNTIME_CAPABILITY_SCHEMA_VERSION;
  readonly contractVersion: typeof TOOLKIT_RUNTIME_CONTRACT_VERSION;
  readonly roles: readonly ["cortex", "flux", "zen"];
  readonly roleInstructionDigests: Readonly<Record<"cortex" | "flux" | "zen", `sha256:${string}`>>;
  readonly roleModels: Readonly<Record<"cortex" | "flux" | "zen", string>>;
  readonly roleMaxSteps: Readonly<Record<"cortex" | "flux" | "zen", number>>;
  readonly roleTemperatures: Readonly<Record<"cortex" | "flux" | "zen", number>>;
  readonly tools: {
    readonly commandRun: "command-run/v1";
    readonly audit: "tool-audit/v1";
    readonly runBudget: "run-budget/v1";
    readonly browserApproval: "visible-browser-approval/v1";
  };
  readonly delegation: {
    readonly nativeTool: "subagent";
    readonly targets: readonly ["cortex", "flux", "zen"];
    readonly delegatedLeavesReceiveSubagent: false;
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
    readonly createAgents: typeof createToolkitAgents;
  };
  readonly tools: {
    readonly commandRun: "command-run/v1";
    readonly createCommandRun: typeof createSandboxCommandRunTool;
    readonly createRunBudgetHooks: typeof createRunBudgetHooks;
    readonly createToolAuditHooks: typeof createToolAuditHooks;
    readonly createVisibleBrowser: typeof createVisibleBrowser;
    readonly browserActionRequiresApproval: typeof browserActionRequiresApproval;
  };
  readonly delegation: ToolkitRuntimeCapabilityDescriptorV1["delegation"];
  readonly containment: typeof RUN_CONTAINMENT_POLICY;
  readonly runtime: {
    readonly profile: ModelProfile;
    readonly defaults: ReturnType<typeof resolveRuntimeDefaultsV1>;
    readonly hostBackgroundTasks: typeof HOST_BACKGROUND_TASK_POLICY;
    readonly agentBackgroundTasks: typeof AGENT_BACKGROUND_TASK_POLICY;
  };
  readonly sandbox: {
    readonly createMachine: typeof createSandboxMachine;
    readonly createCommandRun: typeof createSandboxCommandRunTool;
  };
  readonly workspace: {
    readonly contextKey: typeof TOOLKIT_WORKSPACE_CONTEXT_KEY;
    readonly ProjectMountingManager: typeof ProjectMountingManager;
  };
  readonly capability: ToolkitRuntimeCapabilityDescriptorV1;
}

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
      commandRun: "command-run/v1",
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
  }) as ToolkitRuntimeCapabilityDescriptorV1;

  return deepFreeze({
    version: TOOLKIT_RUNTIME_CONTRACT_VERSION,
    roles: {
      ids: ROLE_IDS,
      definitions: ROLES,
      composePrompt,
      createAgents: createToolkitAgents,
    },
    tools: {
      commandRun: "command-run/v1",
      createCommandRun: createSandboxCommandRunTool,
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
      createCommandRun: createSandboxCommandRunTool,
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
  capability: ToolkitRuntimeCapabilityDescriptorV1 | string,
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
