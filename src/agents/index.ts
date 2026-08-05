import { Agent } from "@mastra/core/agent";
import type { ToolsInput } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import type { ToolHooks } from "@mastra/core/tools";
import type { StagehandBrowser } from "@mastra/stagehand";
import type { AnyWorkspace } from "@mastra/core/workspace";
import {
  TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY,
  TOOLKIT_WORKSPACE_CONTEXT_KEY,
} from "../runtime/request-context.js";
import { createAdhdTool } from "../tools/adhd.js";
import { createCommandRunTool } from "../tools/command-run/tool.js";
import { ARCHETYPES, composePrompt, type Archetype } from "./archetypes.js";
import { loadModelProfile, resolveProxyGatewayModelId, type ModelProfile } from "../models/profile.js";
import { fillMissingSubagentModelId } from "./subagents.js";
import { createToolAuditHooks } from "./audit.js";
import { browserActionRequiresApproval, createVisibleBrowser } from "./browser.js";

export interface ToolkitAgentsOptions {
  readonly workspaceRoot: string;
  readonly browser: boolean;
  readonly browserExecutablePath?: string;
  readonly browserUserDataDir?: string;
  readonly additionalTools?: ToolkitAdditionalTools;
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
  const cortex = createAgent<"cortex">(
    ARCHETYPES.cortex,
    profile,
    { command_run: commandRun },
    options.additionalTools,
    browser(options),
  );
  flux = createAgent<"flux">(
    ARCHETYPES.flux,
    profile,
    { command_run: commandRun, adhd_run: adhdRun },
    options.additionalTools,
    browser(options),
  );
  const zen = createAgent<"zen">(
    ARCHETYPES.zen,
    profile,
    { command_run: commandRun },
    options.additionalTools,
    browser(options),
    { cortex, flux },
  );
  return { cortex, flux, zen };
}

function createAgent<TId extends Archetype["id"]>(
  archetype: Archetype & { readonly id: TId },
  profile: ModelProfile,
  tools: Record<string, ReturnType<typeof createCommandRunTool> | ReturnType<typeof createAdhdTool>>,
  additionalTools?: ToolkitAdditionalTools,
  agentBrowser?: StagehandBrowser,
  agents?: Record<string, Agent>,
): Agent<TId> {
  const auditHooks = createToolAuditHooks();
  const hooks: ToolHooks = {
    beforeToolCall: async context => {
      if (context.toolName === "subagent") fillMissingSubagentModelId(profile, context.input);
      await auditHooks.beforeToolCall?.(context);
    },
    afterToolCall: async context => {
      await auditHooks.afterToolCall?.(context);
    },
  };
  return new Agent({
    id: archetype.id,
    name: archetype.name,
    description: archetype.description,
    instructions: composePrompt(archetype),
    model: resolveProxyGatewayModelId(profile, profile.roles[archetype.id]),
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
      maxSteps: archetype.model.steps,
      modelSettings: { temperature: archetype.model.temperature },
      requireToolApproval: ({ toolName, args }) => browserActionRequiresApproval(toolName, args),
    },
    ...(agentBrowser ? { browser: agentBrowser } : {}),
    ...(agents ? { agents } : {}),
  });
}

function browser(options: ToolkitAgentsOptions): StagehandBrowser | undefined {
  if (!options.browser) return undefined;
  return createVisibleBrowser({
    ...(options.browserExecutablePath ? { executablePath: options.browserExecutablePath } : {}),
    ...(options.browserUserDataDir ? { userDataDir: options.browserUserDataDir } : {}),
  });
}
