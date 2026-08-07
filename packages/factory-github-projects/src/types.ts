export interface GithubProjectBindingConfig {
  readonly id: string;
  readonly orgId: string;
  readonly factoryProjectId: string;
  readonly githubOrganization: string;
  readonly githubProjectNodeId: string;
  readonly githubProjectNumber: number;
  readonly statusFieldId: string;
  readonly statusOptions: {
    readonly backlog: string;
    readonly intake: string;
    readonly investigate: string;
    readonly planning: string;
    readonly building: string;
    readonly review: string;
    readonly done: string;
    readonly canceled: string;
  };
  readonly executionFieldId?: string;
  readonly executionOptions?: {
    readonly automatic: string;
    readonly manual: string;
    readonly hitl: string;
  };
  readonly workTypeFieldId?: string;
  readonly workTypeOptions?: {
    readonly implementation: string;
    readonly research: string;
    readonly prototype: string;
    readonly decision: string;
    readonly map: string;
  };
  readonly workspaceFieldId?: string;
  readonly priorityFieldId?: string;
  readonly workspacePolicies?: readonly WorkspacePolicy[];
  readonly enabled: boolean;
}

export interface WorkspacePolicy {
  readonly projectFieldOptionId: string;
  readonly projectRepositoryId: string;
  readonly allowedPaths?: readonly string[];
  readonly setupCommand?: string;
  readonly validationCommands?: readonly string[];
  readonly concurrency?: number;
}

export interface GithubProjectsFactoryConfig {
  readonly automationUserId: string;
  readonly reconcileIntervalMs: number;
  readonly bindings: readonly GithubProjectBindingConfig[];
}

export interface GithubProjectWorkIdentity {
  readonly projectItemNodeId: string;
  readonly contentNodeId: string;
  readonly repositoryNodeId: string;
  readonly repositoryDatabaseId: number;
  readonly repositoryNameWithOwner: string;
  readonly number: number;
}

export interface GithubProjectItemContent extends Omit<GithubProjectWorkIdentity, "projectItemNodeId"> {
  readonly type: "Issue" | "PullRequest" | "DraftIssue" | "Unsupported";
  readonly title: string;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED";
}

export interface GithubProjectItemSnapshot {
  readonly projectItemNodeId: string;
  readonly content: GithubProjectItemContent;
  readonly fieldValues: Readonly<Record<string, string | number | null>>;
  readonly position: number;
  readonly labels?: readonly string[];
}

export interface NormalizedGithubProjectItem {
  readonly identity: GithubProjectWorkIdentity;
  readonly contentType: GithubProjectItemContent["type"];
  readonly title: string;
  readonly url: string;
  readonly state: GithubProjectItemContent["state"];
  readonly statusOptionId: string | null;
  readonly executionOptionId: string | null;
  readonly workTypeOptionId: string | null;
  readonly workspaceOptionId: string | null;
  readonly priority: number | null;
  readonly position: number;
}

export type ProjectItemEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason:
        | "unsupported_content"
        | "closed"
        | "status_not_intake";
    };

export type FactoryLifecycleStage = "intake" | "triage" | "planning" | "execute" | "review" | "done" | "canceled";
export type ProjectStatusKey = keyof GithubProjectBindingConfig["statusOptions"];

export function normalizeProjectItem(
  binding: GithubProjectBindingConfig,
  snapshot: GithubProjectItemSnapshot,
): NormalizedGithubProjectItem {
  const value = (fieldId: string | undefined) => fieldId ? snapshot.fieldValues[fieldId] : null;
  const option = (fieldId: string | undefined) => {
    const fieldValue = value(fieldId);
    return typeof fieldValue === "string" ? fieldValue : null;
  };
  const priorityValue = value(binding.priorityFieldId);
  return {
    identity: {
      projectItemNodeId: snapshot.projectItemNodeId,
      contentNodeId: snapshot.content.contentNodeId,
      repositoryNodeId: snapshot.content.repositoryNodeId,
      repositoryDatabaseId: snapshot.content.repositoryDatabaseId,
      repositoryNameWithOwner: snapshot.content.repositoryNameWithOwner,
      number: snapshot.content.number,
    },
    contentType: snapshot.content.type,
    title: snapshot.content.title,
    url: snapshot.content.url,
    state: snapshot.content.state,
    statusOptionId: option(binding.statusFieldId),
    executionOptionId: option(binding.executionFieldId),
    workTypeOptionId: option(binding.workTypeFieldId),
    workspaceOptionId: option(binding.workspaceFieldId),
    priority: typeof priorityValue === "number" && Number.isFinite(priorityValue) ? priorityValue : null,
    position: snapshot.position,
  };
}

export function evaluateProjectItem(
  binding: GithubProjectBindingConfig,
  item: NormalizedGithubProjectItem,
): ProjectItemEligibility {
  if (item.contentType !== "Issue") return { eligible: false, reason: "unsupported_content" };
  if (item.state !== "OPEN") return { eligible: false, reason: "closed" };
  if (item.statusOptionId !== binding.statusOptions.intake) return { eligible: false, reason: "status_not_intake" };
  return { eligible: true };
}

export function orderEligibleItems<T extends Pick<NormalizedGithubProjectItem, "identity" | "priority" | "position">>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) =>
    (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER)
    || left.position - right.position
    || left.identity.contentNodeId.localeCompare(right.identity.contentNodeId));
}

export function projectStatusForFactoryStage(stage: FactoryLifecycleStage): ProjectStatusKey {
  if (stage === "triage") return "investigate";
  if (stage === "execute") return "building";
  return stage;
}

export function factoryStageForProjectStatus(
  binding: GithubProjectBindingConfig,
  statusOptionId: string | null,
): FactoryLifecycleStage | undefined {
  const status = Object.entries(binding.statusOptions)
    .find(([, optionId]) => optionId === statusOptionId)?.[0] as ProjectStatusKey | undefined;
  if (!status || status === "backlog") return undefined;
  if (status === "investigate") return "triage";
  if (status === "building") return "execute";
  return status;
}
