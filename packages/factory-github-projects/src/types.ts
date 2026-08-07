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
    readonly ready: string;
    readonly inProgress: string;
    readonly validating: string;
    readonly done: string;
    readonly canceled: string;
  };
  readonly executionFieldId: string;
  readonly executionOptions: {
    readonly automatic: string;
    readonly manual: string;
    readonly hitl: string;
  };
  readonly workTypeFieldId: string;
  readonly workTypeOptions: {
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
  readonly maxConcurrentProjects: number;
  readonly maxConcurrentItemsPerProject: number;
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
  readonly blockedByOpenCount: number;
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
  readonly blockedByOpenCount: number;
}

export type ProjectItemEligibility =
  | { readonly eligible: true; readonly role: "work" | "plan" }
  | {
      readonly eligible: false;
      readonly reason:
        | "unsupported_content"
        | "closed"
        | "status_not_ready"
        | "execution_not_automatic"
        | "blocked"
        | "human_decision"
        | "map_requires_graph_reconciliation"
        | "unknown_work_type";
    };

export type FactoryLifecycleState = "queued" | "active" | "validating" | "verified-complete" | "canceled";
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
    blockedByOpenCount: snapshot.blockedByOpenCount,
  };
}

export function evaluateProjectItem(
  binding: GithubProjectBindingConfig,
  item: NormalizedGithubProjectItem,
): ProjectItemEligibility {
  if (item.contentType !== "Issue") return { eligible: false, reason: "unsupported_content" };
  if (item.state !== "OPEN") return { eligible: false, reason: "closed" };
  if (item.statusOptionId !== binding.statusOptions.ready) return { eligible: false, reason: "status_not_ready" };
  if (item.executionOptionId !== binding.executionOptions.automatic) {
    return { eligible: false, reason: "execution_not_automatic" };
  }
  if (item.blockedByOpenCount > 0) return { eligible: false, reason: "blocked" };
  if (item.workTypeOptionId === binding.workTypeOptions.decision) {
    return { eligible: false, reason: "human_decision" };
  }
  if (item.workTypeOptionId === binding.workTypeOptions.map) {
    return { eligible: false, reason: "map_requires_graph_reconciliation" };
  }
  if (item.workTypeOptionId === binding.workTypeOptions.research) return { eligible: true, role: "plan" };
  if (
    item.workTypeOptionId === binding.workTypeOptions.implementation
    || item.workTypeOptionId === binding.workTypeOptions.prototype
  ) return { eligible: true, role: "work" };
  return { eligible: false, reason: "unknown_work_type" };
}

export function orderEligibleItems<T extends Pick<NormalizedGithubProjectItem, "identity" | "priority" | "position">>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) =>
    (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER)
    || left.position - right.position
    || left.identity.contentNodeId.localeCompare(right.identity.contentNodeId));
}

export function projectStatusForFactoryState(state: FactoryLifecycleState): ProjectStatusKey {
  if (state === "queued") return "backlog";
  if (state === "active") return "inProgress";
  if (state === "validating") return "validating";
  if (state === "verified-complete") return "done";
  return "canceled";
}
