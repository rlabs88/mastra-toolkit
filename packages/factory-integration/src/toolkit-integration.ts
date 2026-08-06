import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { ApiRoute } from "@mastra/core/server";
import { createTool } from "@mastra/core/tools";
import type { FactoryIntegration, IntegrationContext, IntegrationTools } from "@mastra/factory";
import { getFactorySessionAddress } from "@mastra/factory/rules/binding-context";
import {
  TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY,
  TOOLKIT_WORKSPACE_CONTEXT_KEY,
} from "@rlabs/agents-roles";
import type { McodeCapabilityDescriptorV1, McodeRecipeV1 } from "@rlabs/mcode/recipe";
import {
  createSandboxCommandRunTool,
  type SandboxCommandRunAuthorizationContext,
} from "@rlabs/sandbox";
import { z } from "zod";
import { createFactoryProjectWorkflowTool } from "./project-workflow.js";

export class ToolkitFactoryIntegration implements FactoryIntegration {
  readonly id = "mastra-toolkit";

  constructor(private readonly recipe: Pick<McodeRecipeV1, "agents" | "tools" | "capability">) {}

  routes(_context: IntegrationContext): ApiRoute[] {
    return [];
  }

  async agentTools(): Promise<IntegrationTools> {
    return {
      delegate_cortex: delegationTool("delegate_cortex", this.recipe.agents.cortex),
      delegate_flux: delegationTool("delegate_flux", this.recipe.agents.flux),
      delegate_zen: delegationTool("delegate_zen", this.recipe.agents.zen),
      command_run: createSandboxCommandRunTool({ authorize: requireFactoryProjectSession }),
      project_workflow: createFactoryProjectWorkflowTool(),
    } as IntegrationTools;
  }

  diagnostics(): Record<string, unknown> {
    const capability = this.recipe.capability;
    return {
      configured: true,
      agents: ["cortex", "flux", "zen"],
      recursionGuarded: true,
      mcode: factoryMcodeDiagnostics(capability),
    };
  }
}

function factoryMcodeDiagnostics(capability: McodeCapabilityDescriptorV1): Record<string, unknown> {
  return {
    schemaVersion: capability.schemaVersion,
    digest: capability.digest,
    controllerConstruction: "unsupported-upstream",
    repositoryConfiguration: {
      verified: ["published-workflows"],
      upstreamUnverified: ["skills"],
      unsupported: ["instructions", "hooks", "commands", "plugins", "mcp", "specialists"],
    },
    controlPlaneProjectConfig: "isolated-empty-directory",
    globalExecutableConfig: "unsupported-upstream",
  };
}

function delegationTool(id: `delegate_${string}`, agent: Agent) {
  return createTool({
    id,
    description: `Delegate a bounded task to ${agent.name}. The Factory controller remains accountable for integration and verification.`,
    inputSchema: z.object({
      task: z.string().min(1).max(20_000),
      maxSteps: z.number().int().min(1).max(24).default(12),
    }),
    background: { enabled: true, timeoutMs: 300_000 },
    execute: async (input, context) => {
      await requireFactoryProjectSession(context);
      const requestContext = new RequestContext(context.requestContext?.entries());
      requestContext.set(TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY, true);
      if (context.workspace) requestContext.set(TOOLKIT_WORKSPACE_CONTEXT_KEY, context.workspace);
      const result = await agent.generate(input.task, { requestContext, maxSteps: input.maxSteps });
      return { agentId: agent.id, text: result.text, runId: result.runId };
    },
  });
}

async function requireFactoryProjectSession(
  context: SandboxCommandRunAuthorizationContext,
): Promise<void> {
  const workspace = context.workspace;
  if (!getFactorySessionAddress(context.requestContext) || !workspace?.id.startsWith("mfw-")) {
    throw new Error("Factory execution requires a persisted Factory project session");
  }
  const [filesystem, sandbox] = await Promise.all([
    workspace.resolveFilesystem({ requestContext: context.requestContext }),
    workspace.resolveSandbox({ requestContext: context.requestContext }),
  ]);
  if (filesystem?.provider !== "sandbox" || !filesystem.basePath || !sandbox?.executeCommand) {
    throw new Error("Factory execution requires a persisted Factory project session sandbox");
  }
}
