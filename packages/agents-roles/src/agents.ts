import { Agent, type ToolsInput } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import type { ToolHooks } from "@mastra/core/tools";
import type { AnyWorkspace } from "@mastra/core/workspace";
import type { StagehandBrowser } from "@mastra/stagehand";
import {
  browserActionRequiresApproval,
  createRunBudgetHooks,
  createToolAuditHooks,
  createVisibleBrowser,
} from "@rlabs/agent-tools";
import {
  AGENT_BACKGROUND_TASK_POLICY,
  loadModelProfile,
  resolveProxyGatewayModelId,
  type ModelProfile,
} from "@rlabs/runtime-config";
import { CORTEX_ROLE, FLUX_ROLE, ZEN_ROLE, type RoleDefinition } from "./roles.js";
import { composePrompt } from "./prompts.js";

export const TOOLKIT_WORKSPACE_CONTEXT_KEY = "mastraToolkitWorkspace";

export interface ToolkitAgentsOptions {
  readonly browser: boolean;
  /**
   * Durable multi-agent orchestration is constructed by the host and assigned
   * here so role policy remains independent from runtime persistence.
   */
  readonly dynamicWorkflow?: NonNullable<ToolsInput[string]>;
  readonly browserExecutablePath?: string;
  readonly browserUserDataDir?: string;
  readonly additionalTools?: ToolkitAdditionalTools;
  readonly hooks?: ToolHooks;
  readonly profile?: ModelProfile;
}

export type ToolkitAdditionalTools = ToolsInput | ((input: {
  requestContext: RequestContext;
  mastra?: Mastra;
}) => ToolsInput | Promise<ToolsInput>);

export interface ToolkitAgents {
  readonly cortex: Agent<"cortex">;
  readonly flux: Agent<"flux">;
  readonly zen: Agent<"zen">;
}

export interface ToolkitAgentRegistry {
  readonly supervisors: ToolkitAgents;
  readonly leaves: ToolkitAgents;
}

export function createToolkitAgentRegistry(options: ToolkitAgentsOptions): ToolkitAgentRegistry {
  const resolvedOptions = options.profile ? options : { ...options, profile: loadModelProfile() };
  const leaves = createAgentSet(resolvedOptions);
  return {
    leaves,
    supervisors: createAgentSet(resolvedOptions, leaves),
  };
}

export function createToolkitAgents(options: ToolkitAgentsOptions): ToolkitAgents {
  return createAgentSet(options);
}

function createAgentSet(options: ToolkitAgentsOptions, agents?: ToolkitAgents): ToolkitAgents {
  const profile = options.profile ?? loadModelProfile();
  const orchestration = options.dynamicWorkflow
    ? { dynamic_workflow: options.dynamicWorkflow }
    : undefined;
  const cortex = createAgent(
    CORTEX_ROLE,
    profile,
    options.additionalTools,
    browser(options),
    options.hooks,
    agents,
    orchestration,
  );
  const flux = createAgent(
    FLUX_ROLE,
    profile,
    options.additionalTools,
    browser(options),
    options.hooks,
    agents,
  );
  const zen = createAgent(
    ZEN_ROLE,
    profile,
    options.additionalTools,
    browser(options),
    options.hooks,
    agents,
    orchestration,
  );
  return { cortex, flux, zen };
}

function createAgent<TId extends RoleDefinition["id"]>(
  role: RoleDefinition<TId>,
  profile: ModelProfile,
  additionalTools?: ToolkitAdditionalTools,
  agentBrowser?: StagehandBrowser,
  additionalHooks?: ToolHooks,
  agents?: ToolkitAgents,
  roleTools?: ToolsInput,
): Agent<TId> {
  const hooks = composeToolHooks(additionalHooks);
  return new Agent({
    id: role.id,
    name: role.name,
    description: role.description,
    instructions: composePrompt(role),
    model: resolveProxyGatewayModelId(profile, profile.roles[role.id]),
    tools: async ({ requestContext, mastra }) => {
      const resolvedAdditionalTools = typeof additionalTools === "function"
        ? await additionalTools({ requestContext, ...(mastra ? { mastra } : {}) })
        : additionalTools;
      return { ...resolvedAdditionalTools, ...roleTools } as ToolsInput;
    },
    workspace: ({ requestContext, mastra }) =>
      (requestContext.get(TOOLKIT_WORKSPACE_CONTEXT_KEY) as AnyWorkspace | undefined) ?? mastra?.getWorkspace(),
    hooks,
    durable: true,
    backgroundTasks: AGENT_BACKGROUND_TASK_POLICY,
    defaultOptions: {
      maxSteps: role.model.steps,
      modelSettings: { temperature: role.model.temperature },
      requireToolApproval: ({ toolName, args }) => browserActionRequiresApproval(toolName, args),
    },
    ...(agentBrowser ? { browser: agentBrowser } : {}),
    ...(agents ? { agents: { ...agents } } : {}),
  });
}

function composeToolHooks(additionalHooks?: ToolHooks): ToolHooks {
  const auditHooks = createToolAuditHooks();
  const budgetHooks = createRunBudgetHooks();
  return {
    beforeToolCall: async context => {
      let result: Awaited<ReturnType<NonNullable<ToolHooks["beforeToolCall"]>>>;
      try {
        await budgetHooks.beforeToolCall?.(context);
        result = await additionalHooks?.beforeToolCall?.(context);
      } finally {
        await auditHooks.beforeToolCall?.(context);
      }
      return result;
    },
    afterToolCall: async context => {
      try {
        await budgetHooks.afterToolCall?.(context);
        await additionalHooks?.afterToolCall?.(context);
      } finally {
        await auditHooks.afterToolCall?.(context);
      }
    },
  };
}

function browser(options: ToolkitAgentsOptions): StagehandBrowser | undefined {
  if (!options.browser) return undefined;
  return createVisibleBrowser({
    ...(options.browserExecutablePath ? { executablePath: options.browserExecutablePath } : {}),
    ...(options.browserUserDataDir ? { userDataDir: options.browserUserDataDir } : {}),
  });
}
