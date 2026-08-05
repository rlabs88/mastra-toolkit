import { Agent, type ToolsInput } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import type { ToolHooks } from "@mastra/core/tools";
import type { AnyWorkspace } from "@mastra/core/workspace";
import type { StagehandBrowser } from "@mastra/stagehand";
import {
  browserActionRequiresApproval,
  createAdhdTool,
  createCommandRunTool,
  createToolAuditHooks,
  createVisibleBrowser,
} from "@rlabs/agent-tools";
import {
  loadModelProfile,
  resolveProxyGatewayModelId,
  type ModelProfile,
} from "@rlabs/runtime-config";
import { CORTEX_ROLE } from "./cortex/index.js";
import { FLUX_ROLE } from "./flux/index.js";
import { composePrompt } from "./prompt.js";
import type { RoleDefinition } from "./role.js";
import { ZEN_ROLE } from "./zen/index.js";

export const TOOLKIT_WORKSPACE_CONTEXT_KEY = "mastraToolkitWorkspace";
export const TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY = "mastraToolkitFactoryDelegation";

export interface ToolkitAgentsOptions {
  readonly workspaceRoot: string;
  readonly browser: boolean;
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
  const commandRun = createCommandRunTool({ workspaceRoot: options.workspaceRoot });
  let flux!: Agent<"flux">;
  const adhdRun = createAdhdTool(() => flux);
  const cortex = createAgent(
    CORTEX_ROLE,
    profile,
    { command_run: commandRun },
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
    { command_run: commandRun },
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
  tools: Record<string, ReturnType<typeof createCommandRunTool> | ReturnType<typeof createAdhdTool>>,
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
      const combinedTools = { ...resolvedAdditionalTools, ...tools } as ToolsInput;
      if (!(requestContext.get(TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY) as boolean | undefined)) {
        return combinedTools;
      }
      const { command_run: _hostCommandRun, ...sandboxSafeTools } = combinedTools;
      return sandboxSafeTools as ToolsInput;
    },
    workspace: ({ requestContext, mastra }) =>
      (requestContext.get(TOOLKIT_WORKSPACE_CONTEXT_KEY) as AnyWorkspace | undefined) ?? mastra?.getWorkspace(),
    hooks,
    durable: true,
    backgroundTasks: { tools: "all", concurrency: 4, waitTimeoutMs: 30_000 },
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
  return {
    beforeToolCall: async context => {
      let result: Awaited<ReturnType<NonNullable<ToolHooks["beforeToolCall"]>>>;
      try {
        result = await additionalHooks?.beforeToolCall?.(context);
      } finally {
        await auditHooks.beforeToolCall?.(context);
      }
      return result;
    },
    afterToolCall: async context => {
      try {
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
