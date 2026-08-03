import { Agent } from "@mastra/core/agent";
import type { ToolsInput } from "@mastra/core/agent";
import type { StagehandBrowser } from "@mastra/stagehand";
import type { AnyWorkspace } from "@mastra/core/workspace";
import {
  TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY,
  TOOLKIT_WORKSPACE_CONTEXT_KEY,
} from "../runtime/request-context.js";
import { createAdhdTool } from "../tools/adhd.js";
import { createCommandRunTool } from "../tools/command-run/tool.js";
import { ARCHETYPES, composePrompt, type Archetype } from "./archetypes.js";
import { createToolAuditHooks } from "./audit.js";
import { browserActionRequiresApproval, createVisibleBrowser } from "./browser.js";

export interface ToolkitAgentsOptions {
  readonly workspaceRoot: string;
  readonly browser: boolean;
  readonly browserExecutablePath?: string;
  readonly browserUserDataDir?: string;
}

export interface ToolkitAgents {
  readonly cortex: Agent<"cortex">;
  readonly flux: Agent<"flux">;
  readonly zen: Agent<"zen">;
}

export function createToolkitAgents(options: ToolkitAgentsOptions): ToolkitAgents {
  const commandRun = createCommandRunTool({ workspaceRoot: options.workspaceRoot });
  let flux!: Agent<"flux">;
  const adhdRun = createAdhdTool(() => flux);
  const cortex = createAgent<"cortex">(ARCHETYPES.cortex, { command_run: commandRun }, browser(options));
  flux = createAgent<"flux">(ARCHETYPES.flux, { command_run: commandRun, adhd_run: adhdRun }, browser(options));
  const zen = createAgent<"zen">(ARCHETYPES.zen, { command_run: commandRun }, browser(options), { cortex, flux });
  return { cortex, flux, zen };
}

function createAgent<TId extends Archetype["id"]>(
  archetype: Archetype & { readonly id: TId },
  tools: Record<string, ReturnType<typeof createCommandRunTool> | ReturnType<typeof createAdhdTool>>,
  agentBrowser?: StagehandBrowser,
  agents?: Record<string, Agent>,
): Agent<TId> {
  return new Agent({
    id: archetype.id,
    name: archetype.name,
    description: archetype.description,
    instructions: composePrompt(archetype),
    model: `proxy/${archetype.model.id}`,
    tools: ({ requestContext }) => {
      if (!(requestContext.get(TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY) as boolean | undefined)) return tools;
      const { command_run: _hostCommandRun, ...sandboxSafeTools } = tools;
      return sandboxSafeTools as ToolsInput;
    },
    workspace: ({ requestContext, mastra }) =>
      (requestContext.get(TOOLKIT_WORKSPACE_CONTEXT_KEY) as AnyWorkspace | undefined) ?? mastra?.getWorkspace(),
    hooks: createToolAuditHooks(),
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
