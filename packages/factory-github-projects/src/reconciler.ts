import { randomUUID } from "node:crypto";
import type { FactoryAutomationCommands } from "@mastra/factory";
import type { GithubProjectsPort } from "./github-projects-client.js";
import type { GithubProjectsStorage } from "./storage.js";
import {
  evaluateProjectItem,
  factoryStageForProjectStatus,
  normalizeProjectItem,
  orderEligibleItems,
  projectStatusForFactoryStage,
  type FactoryLifecycleStage,
  type GithubProjectBindingConfig,
  type GithubProjectsFactoryConfig,
  type NormalizedGithubProjectItem,
  type ProjectStatusKey,
  type WorkspacePolicy,
} from "./types.js";

export type FactoryAutomationCommandsPort = Pick<
  FactoryAutomationCommands,
  "prepareWorkItem" | "transitionWorkItem" | "getWorkItem"
>;

export interface LinkedRepositoryResolver {
  resolveLinkedRepository(input: {
    orgId: string;
    factoryProjectId: string;
    repositoryDatabaseId: number;
    repositoryNameWithOwner: string;
  }): Promise<{ projectRepositoryId: string } | null>;
}

export interface FactoryProjectDefaultsResolver {
  resolveDefaultModelId(input: {
    orgId: string;
    factoryProjectId: string;
  }): Promise<string | null | undefined>;
}

export interface ReconcileResult {
  readonly admitted: number;
  readonly transitioned: number;
  readonly projected: number;
  readonly skippedLease: number;
  readonly existingExecutions: number;
  readonly rejected: Array<{ bindingId: string; contentNodeId: string; reason: string }>;
}

export class GithubProjectsReconciler {
  #inFlight: Promise<ReconcileResult> | undefined;

  constructor(private readonly options: {
    config: GithubProjectsFactoryConfig;
    storage: GithubProjectsStorage;
    github: GithubProjectsPort;
    commands: FactoryAutomationCommandsPort;
    repositories: LinkedRepositoryResolver;
    factoryProjects?: FactoryProjectDefaultsResolver;
    ownerId: string;
  }) {}

  async runOnce(): Promise<ReconcileResult> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#executeRunOnce();
    try { return await this.#inFlight; }
    finally { this.#inFlight = undefined; }
  }

  async #executeRunOnce(): Promise<ReconcileResult> {
    const result: MutableReconcileResult = {
      admitted: 0,
      transitioned: 0,
      projected: 0,
      skippedLease: 0,
      existingExecutions: 0,
      rejected: [],
    };
    const schedulerAcquired = await this.options.storage.acquireSchedulerLease({
      scope: "reconcile",
      ownerId: this.options.ownerId,
      ttlMs: Math.max(this.options.config.reconcileIntervalMs * 2, 60_000),
    });
    if (!schedulerAcquired) return result;

    const pending = await this.options.storage.listPendingReconciles();
    try {
      const bindings = this.options.config.bindings.filter(binding => binding.enabled);
      for (const binding of bindings) {
        await this.options.storage.upsertBinding(binding);
        const snapshots = await this.options.github.listProjectItems(binding);
        const normalized = snapshots.map(snapshot => normalizeProjectItem(binding, snapshot));
        const unmanagedIntake: NormalizedGithubProjectItem[] = [];

        for (const item of normalized) {
          const existing = await this.options.storage.getExecution(item.identity.contentNodeId);
          if (!existing) {
            const eligibility = evaluateProjectItem(binding, item);
            if (eligibility.eligible) unmanagedIntake.push(item);
            else if (factoryStageForProjectStatus(binding, item.statusOptionId)) {
              const reason = eligibility.reason === "status_not_intake" ? "intake_required" : eligibility.reason;
              await this.#rejectAndProjectBacklog(binding, item, reason, result);
            }
            continue;
          }

          result.existingExecutions += 1;
          if (existing.bindingId !== binding.id) {
            await this.#rejectAndProjectBacklog(binding, item, "owned_by_another_binding", result);
            continue;
          }
          const workItem = await this.options.commands.getWorkItem({
            orgId: binding.orgId,
            factoryProjectId: binding.factoryProjectId,
            workItemId: existing.workItemId,
          });
          if (!workItem) {
            const eligibility = evaluateProjectItem(binding, item);
            if (eligibility.eligible) {
              const outcome = await this.#admitItem(binding, item, existing.workItemId, result);
              if (outcome === "admitted") result.admitted += 1;
              if (outcome === "lease-unavailable") result.skippedLease += 1;
            } else {
              const reason = eligibility.reason === "status_not_intake" ? "intake_required" : eligibility.reason;
              await this.#rejectAndProjectBacklog(binding, item, reason, result);
            }
            continue;
          }
          await this.#reconcileManagedItem(binding, item, existing.workItemId, existing.status, workItem, result);
        }

        for (const item of orderEligibleItems(unmanagedIntake)) {
          const outcome = await this.#admitItem(binding, item, randomUUID(), result);
          if (outcome === "admitted") result.admitted += 1;
          if (outcome === "lease-unavailable") result.skippedLease += 1;
        }
      }
      await Promise.all(pending.map(request => this.options.storage.completeReconcile(request.id)));
    } catch (error) {
      await Promise.all(pending.map(request => this.options.storage.failReconcile(request.id, error)));
      throw error;
    }
    return result;
  }

  async #reconcileManagedItem(
    binding: GithubProjectBindingConfig,
    item: NormalizedGithubProjectItem,
    workItemId: string,
    lastSyncedStatus: string,
    workItem: { stages: readonly string[]; revision: number },
    result: MutableReconcileResult,
  ): Promise<void> {
    let actualStage = factoryStageForStages(workItem.stages);
    if (!actualStage) {
      await this.#reject(binding, item, "unknown_factory_stage", result);
      return;
    }
    let actualStatus = projectStatusForFactoryStage(actualStage);
    const managedContentRejection = item.contentType !== "Issue"
      ? "unsupported_content"
      : item.state !== "OPEN" ? "closed" : undefined;
    if (managedContentRejection) {
      await this.#reject(binding, item, managedContentRejection, result);
      await this.#syncManagedStatus(binding, item, actualStatus, workItemId, result);
      return;
    }
    const desiredStage = factoryStageForProjectStatus(binding, item.statusOptionId);
    const desiredStatus = projectStatusKeyForOption(binding, item.statusOptionId);
    const factoryChanged = lastSyncedStatus !== actualStatus;
    const projectChanged = desiredStatus !== undefined && desiredStatus !== lastSyncedStatus;

    if (factoryChanged) {
      if (projectChanged && desiredStatus !== actualStatus) {
        await this.#reject(binding, item, "concurrent_status_change_factory_won", result);
      }
    } else if (projectChanged) {
      if (!desiredStage) {
        await this.#reject(binding, item, "admitted_item_cannot_return_to_backlog", result);
      } else if (desiredStage !== actualStage) {
        const transition = await this.options.commands.transitionWorkItem({
          orgId: binding.orgId,
          factoryProjectId: binding.factoryProjectId,
          workItemId,
          board: "work",
          stage: desiredStage,
          expectedRevision: workItem.revision,
          cause: "github_projects_status_sync",
          idempotencyKey: `${item.identity.contentNodeId}:${desiredStage}:${workItem.revision}`,
        });
        if (transition.status === "accepted") {
          actualStage = transition.stage;
          actualStatus = projectStatusForFactoryStage(actualStage);
          result.transitioned += 1;
        } else {
          await this.#reject(binding, item, `transition_rejected:${transition.code}`, result);
          const refreshed = await this.options.commands.getWorkItem({
            orgId: binding.orgId,
            factoryProjectId: binding.factoryProjectId,
            workItemId,
          });
          const refreshedStage = refreshed ? factoryStageForStages(refreshed.stages) : undefined;
          if (refreshedStage) {
            actualStage = refreshedStage;
            actualStatus = projectStatusForFactoryStage(actualStage);
          }
        }
      }
    }

    await this.#syncManagedStatus(binding, item, actualStatus, workItemId, result);
  }

  async #syncManagedStatus(
    binding: GithubProjectBindingConfig,
    item: NormalizedGithubProjectItem,
    actualStatus: ProjectStatusKey,
    workItemId: string,
    result: MutableReconcileResult,
  ): Promise<void> {
    if (item.statusOptionId !== binding.statusOptions[actualStatus]) {
      await this.options.github.setStatus(item.identity.projectItemNodeId, binding.statusOptions[actualStatus], binding);
      result.projected += 1;
    }
    const execution = await this.options.storage.getExecution(item.identity.contentNodeId);
    if (!execution) throw new Error("Managed GitHub Project execution disappeared during reconciliation");
    await this.options.storage.recordExecution({
      contentNodeId: item.identity.contentNodeId,
      bindingId: binding.id,
      projectItemNodeId: item.identity.projectItemNodeId,
      workItemId,
      status: actualStatus,
    });
  }

  async #admitItem(
    binding: GithubProjectBindingConfig,
    item: NormalizedGithubProjectItem,
    workItemId: string,
    result: MutableReconcileResult,
  ): Promise<"admitted" | "rejected" | "lease-unavailable"> {
    const repository = await this.options.repositories.resolveLinkedRepository({
      orgId: binding.orgId,
      factoryProjectId: binding.factoryProjectId,
      repositoryDatabaseId: item.identity.repositoryDatabaseId,
      repositoryNameWithOwner: item.identity.repositoryNameWithOwner,
    });
    if (!repository) {
      await this.#rejectAndProjectBacklog(binding, item, "unlinked_repository", result);
      return "rejected";
    }
    const workspace = resolveWorkspace(binding.workspacePolicies ?? [], item);
    if (workspace === false) {
      await this.#rejectAndProjectBacklog(binding, item, "invalid_workspace", result);
      return "rejected";
    }
    if (workspace && workspace.projectRepositoryId !== repository.projectRepositoryId) {
      await this.#rejectAndProjectBacklog(binding, item, "workspace_repository_mismatch", result);
      return "rejected";
    }
    const acquired = await this.options.storage.acquireExecutionLease({
      contentNodeId: item.identity.contentNodeId,
      bindingId: binding.id,
      ownerId: this.options.ownerId,
      ttlMs: 20 * 60_000,
    });
    if (!acquired) return "lease-unavailable";
    await this.options.storage.recordExecution({
      contentNodeId: item.identity.contentNodeId,
      bindingId: binding.id,
      projectItemNodeId: item.identity.projectItemNodeId,
      workItemId,
      status: "preparing",
    });
    const defaultModelId = await this.options.factoryProjects?.resolveDefaultModelId({
      orgId: binding.orgId,
      factoryProjectId: binding.factoryProjectId,
    });
    const prepared = await this.options.commands.prepareWorkItem({
      orgId: binding.orgId,
      userId: this.options.config.automationUserId,
      factoryProjectId: binding.factoryProjectId,
      projectRepositoryId: repository.projectRepositoryId,
      projectItemNodeId: item.identity.projectItemNodeId,
      contentNodeId: item.identity.contentNodeId,
      repositoryNameWithOwner: item.identity.repositoryNameWithOwner,
      number: item.identity.number,
      title: item.title,
      url: item.url,
      kickoffKey: `github-project:${item.identity.contentNodeId}`,
      role: "triage",
      workItemId,
      ...(defaultModelId ? { defaultModelId } : {}),
      ...(workspace ? { metadata: { workspacePolicy: workspace } } : {}),
    });
    await this.options.storage.recordExecution({
      contentNodeId: item.identity.contentNodeId,
      bindingId: binding.id,
      projectItemNodeId: item.identity.projectItemNodeId,
      workItemId: prepared.workItemId,
      status: "intake",
    });
    return "admitted";
  }

  async #rejectAndProjectBacklog(
    binding: GithubProjectBindingConfig,
    item: NormalizedGithubProjectItem,
    reason: string,
    result: MutableReconcileResult,
  ): Promise<void> {
    await this.#reject(binding, item, reason, result);
    if (item.statusOptionId !== binding.statusOptions.backlog) {
      await this.options.github.setStatus(
        item.identity.projectItemNodeId,
        binding.statusOptions.backlog,
        binding,
      );
      result.projected += 1;
    }
  }

  async #reject(
    binding: GithubProjectBindingConfig,
    item: NormalizedGithubProjectItem,
    reason: string,
    result: MutableReconcileResult,
  ): Promise<void> {
    const diagnostic = { bindingId: binding.id, contentNodeId: item.identity.contentNodeId, reason };
    result.rejected.push(diagnostic);
    await this.options.storage.recordDiagnostic(diagnostic);
  }
}

type MutableReconcileResult = {
  -readonly [Key in keyof ReconcileResult]: ReconcileResult[Key];
};

function factoryStageForStages(stages: readonly string[]): FactoryLifecycleStage | undefined {
  return stages.find((stage): stage is FactoryLifecycleStage =>
    stage === "intake" || stage === "triage" || stage === "planning" || stage === "execute"
    || stage === "review" || stage === "done" || stage === "canceled");
}

function projectStatusKeyForOption(
  binding: GithubProjectBindingConfig,
  statusOptionId: string | null,
): ProjectStatusKey | undefined {
  return Object.entries(binding.statusOptions)
    .find(([, optionId]) => optionId === statusOptionId)?.[0] as ProjectStatusKey | undefined;
}

function resolveWorkspace(
  policies: readonly WorkspacePolicy[],
  item: NormalizedGithubProjectItem,
) {
  if (policies.length === 0) return undefined;
  if (!item.workspaceOptionId) return false;
  return policies.find(policy => policy.projectFieldOptionId === item.workspaceOptionId) ?? false;
}
