import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { ApiRoute } from "@mastra/core/server";
import { createTool } from "@mastra/core/tools";
import type { FactoryIntegration, IntegrationContext, IntegrationTools } from "@mastra/factory";
import {
  TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY,
  TOOLKIT_WORKSPACE_CONTEXT_KEY,
  type ToolkitAgents,
} from "@rlabs/agents-roles";
import { z } from "zod";
import { createFactoryProjectWorkflowTool } from "./project-workflow.js";

export class ToolkitFactoryIntegration implements FactoryIntegration {
  readonly id = "mastra-toolkit";

  constructor(private readonly agents: ToolkitAgents) {}

  routes(_context: IntegrationContext): ApiRoute[] {
    return [];
  }

  async agentTools(): Promise<IntegrationTools> {
    return {
      delegate_cortex: delegationTool("delegate_cortex", this.agents.cortex),
      delegate_flux: delegationTool("delegate_flux", this.agents.flux),
      delegate_zen: delegationTool("delegate_zen", this.agents.zen),
      project_workflow: createFactoryProjectWorkflowTool(),
    } as IntegrationTools;
  }

  diagnostics(): Record<string, unknown> {
    return { configured: true, agents: ["cortex", "flux", "zen"], recursionGuarded: true };
  }
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
      const requestContext = new RequestContext(context.requestContext?.entries());
      requestContext.set(TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY, true);
      if (context.workspace) requestContext.set(TOOLKIT_WORKSPACE_CONTEXT_KEY, context.workspace);
      const result = await agent.generate(input.task, { requestContext, maxSteps: input.maxSteps });
      return { agentId: agent.id, text: result.text, runId: result.runId };
    },
  });
}
