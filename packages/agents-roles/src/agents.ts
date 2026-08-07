import { Agent, type ToolsInput } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import type { ToolHooks } from "@mastra/core/tools";
import type { AnyWorkspace } from "@mastra/core/workspace";
import type { StagehandBrowser } from "@mastra/stagehand";
import {
  browserActionRequiresApproval,
  createAdhdTool,
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
export const TOOLKIT_DELEGATED_RUN_CONTEXT_KEY = "mastraToolkitDelegatedRun";

export interface ToolkitAgentsOptions {
  readonly browser: boolean;
  readonly commandRun: NonNullable<ToolsInput[string]>;
  /**
   * Durable multi-agent orchestration. Injected by the host, like `commandRun`,
   * so this package keeps owning role policy rather than tool construction.
   * Attached to Cortex and Zen only: Flux is the exploration role and keeps
   * `adhd_run`, which needs no approval.
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

export function createToolkitAgents(options: ToolkitAgentsOptions): ToolkitAgents {
  const profile = options.profile ?? loadModelProfile();
  const commandRun = options.commandRun;
  let flux!: Agent<"flux">;
  const adhdRun = createAdhdTool(() => flux);
  const orchestration = options.dynamicWorkflow
    ? { dynamic_workflow: options.dynamicWorkflow }
    : {};
  const cortex = createAgent(
    CORTEX_ROLE,
    profile,
    { command_run: commandRun, ...orchestration },
    options.additionalTools,
    browser(options),
    options.hooks,
  );
  flux = createAgent(
    FLUX_ROLE,
    profile,
    { command_run: commandRun, adhd_run: adhdRun },
    options.additionalTools,
    browser(options),
    options.hooks,
  );
  const zen = createAgent(
    ZEN_ROLE,
    profile,
    { command_run: commandRun, ...orchestration },
    options.additionalTools,
    browser(options),
    options.hooks,
    { cortex, flux },
  );
  return { cortex, flux, zen };
}

function createAgent<TId extends RoleDefinition["id"]>(
  role: RoleDefinition<TId>,
  profile: ModelProfile,
  tools: ToolsInput,
  additionalTools?: ToolkitAdditionalTools,
  agentBrowser?: StagehandBrowser,
  additionalHooks?: ToolHooks,
  agents?: Record<string, Agent>,
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
      return { ...resolvedAdditionalTools, ...tools } as ToolsInput;
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
    ...(agents ? { agents } : {}),
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
