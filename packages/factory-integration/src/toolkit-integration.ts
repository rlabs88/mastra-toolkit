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
import {
  createMcodeRecipe,
  type McodeCapabilityDescriptorV1,
  type McodeRecipeOptions,
  type McodeRecipeV1,
} from "@rlabs/mcode";
import {
  createSandboxCommandRunTool,
  type SandboxCommandRunAuthorizationContext,
} from "@rlabs/sandbox";
import { z } from "zod";
import { createFactoryProjectWorkflowTool } from "./project-workflow.js";

const MAX_DELEGATED_TOOL_RESULTS = 24;
const MAX_DELEGATED_TOOL_RESULT_CHARS = 4_000;
const FACTORY_MCODE_RECIPE = Symbol("factory-mcode-recipe");

export type FactoryMcodeRecipe = McodeRecipeV1 & {
  readonly [FACTORY_MCODE_RECIPE]: true;
};

const delegationOutputSchema = z.object({
  agentId: z.string(),
  text: z.string(),
  runId: z.string().optional(),
  toolResults: z.array(z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    output: z.string().max(MAX_DELEGATED_TOOL_RESULT_CHARS),
    truncated: z.boolean(),
  })).max(MAX_DELEGATED_TOOL_RESULTS),
});

export class ToolkitFactoryIntegration implements FactoryIntegration {
  readonly id = "mastra-toolkit";

  constructor(private readonly recipe: FactoryMcodeRecipe) {
    if (recipe[FACTORY_MCODE_RECIPE] !== true) {
      throw new Error("Factory MCode recipes must be created with createFactoryMcodeRecipe");
    }
  }

  routes(_context: IntegrationContext): ApiRoute[] {
    return [];
  }

  async agentTools(): Promise<IntegrationTools> {
    return {
      delegate_cortex: delegationTool("delegate_cortex", this.recipe.agents.cortex),
      delegate_flux: delegationTool("delegate_flux", this.recipe.agents.flux),
      delegate_zen: delegationTool("delegate_zen", this.recipe.agents.zen),
      command_run: createFactoryCommandRunTool(),
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

export function createFactoryCommandRunTool() {
  return createSandboxCommandRunTool({ authorize: requireFactoryProjectSession });
}

export function createFactoryMcodeRecipe(
  options: Omit<McodeRecipeOptions, "commandRun">,
): FactoryMcodeRecipe {
  return Object.assign(createMcodeRecipe({
    ...options,
    commandRun: createFactoryCommandRunTool(),
  }), {
    [FACTORY_MCODE_RECIPE]: true as const,
  });
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
    outputSchema: delegationOutputSchema,
    background: { enabled: true, timeoutMs: 300_000 },
    execute: async (input, context) => {
      await requireFactoryProjectSession(context);
      const requestContext = new RequestContext(context.requestContext?.entries());
      requestContext.set(TOOLKIT_FACTORY_DELEGATION_CONTEXT_KEY, true);
      if (context.workspace) requestContext.set(TOOLKIT_WORKSPACE_CONTEXT_KEY, context.workspace);
      const result = await agent.generate(input.task, {
        requestContext,
        maxSteps: input.maxSteps,
        ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
      });
      return {
        agentId: agent.id,
        text: result.text,
        runId: result.runId,
        toolResults: result.steps
          .flatMap(step => step.toolResults)
          .slice(0, MAX_DELEGATED_TOOL_RESULTS)
          .map(projectDelegatedToolResult),
      };
    },
  });
}

function projectDelegatedToolResult(input: unknown): z.infer<typeof delegationOutputSchema>["toolResults"][number] {
  const record = asRecord(input);
  const payload = asRecord(record?.payload) ?? record;
  const value = payload && "result" in payload ? payload.result : input;
  const serialized = serializeToolResult(value);
  return {
    toolCallId: stringField(payload, "toolCallId", "unknown-tool-call"),
    toolName: stringField(payload, "toolName", "unknown-tool"),
    output: serialized.slice(0, MAX_DELEGATED_TOOL_RESULT_CHARS),
    truncated: serialized.length > MAX_DELEGATED_TOOL_RESULT_CHARS,
  };
}

function serializeToolResult(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[Unserializable tool result]";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string, fallback: string): string {
  return typeof record?.[key] === "string" ? record[key] : fallback;
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
