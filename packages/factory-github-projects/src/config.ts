import { z } from "zod";
import type { GithubProjectsFactoryConfig } from "./types.js";

const id = z.string().trim().min(1);
const bindingSchema = z.object({
  id,
  orgId: id,
  factoryProjectId: id,
  githubOrganization: id,
  githubProjectNodeId: id,
  githubProjectNumber: z.number().int().positive(),
  statusFieldId: id,
  statusOptions: z.object({
    backlog: id, ready: id, inProgress: id, validating: id, done: id, canceled: id,
  }),
  executionFieldId: id,
  executionOptions: z.object({ automatic: id, manual: id, hitl: id }),
  workTypeFieldId: id,
  workTypeOptions: z.object({ implementation: id, research: id, prototype: id, decision: id, map: id }),
  workspaceFieldId: id.optional(),
  priorityFieldId: id.optional(),
  workspacePolicies: z.array(z.object({
    projectFieldOptionId: id,
    projectRepositoryId: id,
    allowedPaths: z.array(id).optional(),
    setupCommand: id.optional(),
    validationCommands: z.array(id).optional(),
    concurrency: z.number().int().positive().max(32).optional(),
  })).optional(),
  enabled: z.boolean().default(true),
}).superRefine((binding, context) => {
  requireUniqueIds(context, Object.values(binding.statusOptions), "status option IDs");
  requireUniqueIds(context, Object.values(binding.executionOptions), "execution option IDs");
  requireUniqueIds(context, Object.values(binding.workTypeOptions), "work type option IDs");
  requireUniqueIds(context, [
    binding.statusFieldId,
    binding.executionFieldId,
    binding.workTypeFieldId,
    binding.workspaceFieldId,
    binding.priorityFieldId,
  ].filter((value): value is string => Boolean(value)), "field IDs");
  if (binding.workspacePolicies?.length && !binding.workspaceFieldId) {
    context.addIssue({ code: "custom", message: "workspacePolicies require workspaceFieldId" });
  }
  requireUniqueIds(
    context,
    binding.workspacePolicies?.map(policy => policy.projectFieldOptionId) ?? [],
    "workspace policy option IDs",
  );
  for (const policy of binding.workspacePolicies ?? []) {
    if (policy.allowedPaths?.length || policy.setupCommand || policy.validationCommands?.length || policy.concurrency) {
      context.addIssue({
        code: "custom",
        message: "workspace execution restrictions are unsupported by the pinned Factory boundary",
      });
    }
  }
});

const configSchema = z.object({
  reconcileIntervalMs: z.number().int().min(5_000).max(3_600_000).default(60_000),
  maxConcurrentProjects: z.number().int().positive().max(32).default(4),
  maxConcurrentItemsPerProject: z.number().int().positive().max(32).default(1),
  bindings: z.array(bindingSchema).min(1),
});

export interface LoadedGithubProjectsConfig {
  readonly config: GithubProjectsFactoryConfig;
}

export function loadGithubProjectsConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LoadedGithubProjectsConfig | undefined {
  const serialized = environment.GITHUB_PROJECTS_CONFIG?.trim();
  const automationUserId = environment.GITHUB_PROJECTS_AUTOMATION_USER_ID?.trim();
  if (!serialized && !automationUserId) return undefined;
  if (!serialized) throw new Error("GITHUB_PROJECTS_CONFIG is required when GitHub Projects V2 is configured");
  if (!automationUserId) {
    throw new Error("GITHUB_PROJECTS_AUTOMATION_USER_ID is required when GitHub Projects V2 is configured");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw new Error("GITHUB_PROJECTS_CONFIG must be valid JSON");
  }
  const parsed = configSchema.parse(decoded);
  const factoryProjectIds = new Set<string>();
  const projectNodeIds = new Set<string>();
  const bindingIds = new Set<string>();
  for (const binding of parsed.bindings) {
    if (bindingIds.has(binding.id)) {
      throw new Error(`GitHub Projects binding ID '${binding.id}' must be unique`);
    }
    if (factoryProjectIds.has(binding.factoryProjectId)) {
      throw new Error(`Factory project '${binding.factoryProjectId}' may bind to only one GitHub Project`);
    }
    if (projectNodeIds.has(binding.githubProjectNodeId)) {
      throw new Error(`GitHub Project '${binding.githubProjectNodeId}' may bind to only one Factory project`);
    }
    factoryProjectIds.add(binding.factoryProjectId);
    projectNodeIds.add(binding.githubProjectNodeId);
    bindingIds.add(binding.id);
  }
  const config = JSON.parse(JSON.stringify({ ...parsed, automationUserId })) as GithubProjectsFactoryConfig;
  return { config };
}

function requireUniqueIds(
  context: z.RefinementCtx,
  values: readonly string[],
  label: string,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `${label} must be unique` });
  }
}
