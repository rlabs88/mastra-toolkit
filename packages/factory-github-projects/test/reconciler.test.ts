import { LibSQLFactoryStorage } from "@mastra/libsql";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GithubProjectsReconciler,
  GithubProjectsStorage,
  createGithubProjectsFactoryIntegration,
  type FactoryAutomationCommandsPort,
  type GithubProjectBindingConfig,
  type GithubProjectItemSnapshot,
} from "../src/index.js";

const stores: LibSQLFactoryStorage[] = [];
afterEach(async () => Promise.all(stores.splice(0).map(store => store.close())));

const options = {
  backlog: "backlog", intake: "intake", investigate: "investigate", planning: "planning",
  building: "building", review: "review", done: "done", canceled: "canceled",
} as const;

function binding(id: string, factoryProjectId: string, projectNodeId: string): GithubProjectBindingConfig {
  return {
    id, orgId: "org-1", factoryProjectId, githubOrganization: "rlabs88",
    githubProjectNodeId: projectNodeId, githubProjectNumber: Number(id.at(-1) ?? 1),
    statusFieldId: "status", statusOptions: options,
    executionFieldId: "execution", executionOptions: { automatic: "auto", manual: "manual", hitl: "hitl" },
    workTypeFieldId: "workType",
    workTypeOptions: {
      implementation: "implementation", research: "research", prototype: "prototype",
      decision: "decision", map: "map",
    },
    enabled: true,
  };
}

function item(
  contentNodeId: string,
  repositoryDatabaseId: number,
  repository: string,
  status = "intake",
): GithubProjectItemSnapshot {
  return {
    projectItemNodeId: `PVTI_${contentNodeId}`,
    content: {
      type: "Issue", contentNodeId, repositoryNodeId: `R_${repositoryDatabaseId}`,
      repositoryDatabaseId, repositoryNameWithOwner: repository, number: 42,
      title: `Issue in ${repository}`, url: `https://github.com/${repository}/issues/42`, state: "OPEN",
    },
    fieldValues: { status, execution: "auto", workType: "implementation" },
    position: 1,
  };
}

async function storage() {
  const root = new LibSQLFactoryStorage({ id: `reconciler-${stores.length}`, url: ":memory:" });
  stores.push(root);
  const projects = root.registerDomain(new GithubProjectsStorage());
  await root.init();
  return projects;
}

function accepted(stage: "triage" | "planning" | "execute" | "review" | "done" | "canceled", revision: number) {
  return {
    status: "accepted" as const,
    transitionId: `transition-${revision}`,
    itemId: "work-1",
    revision,
    stage,
    decisions: [],
  };
}

describe("GithubProjectsReconciler", () => {
  test("admits an Intake issue without queueing an agent kickoff", async () => {
    const projects = await storage();
    const prepareWorkItem = vi.fn(async input => ({ workItemId: input.workItemId }));
    const startWorkItem = vi.fn();
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_intake", 101, "rlabs88/repo-a")], setStatus: vi.fn() },
      commands: {
        prepareWorkItem,
        startWorkItem,
        transitionWorkItem: vi.fn(),
        getWorkItem: vi.fn(async () => ({ stages: ["intake"], revision: 1 })),
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({ admitted: 1, transitioned: 0 });

    expect(prepareWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      contentNodeId: "I_intake",
      role: "triage",
    }));
    expect(startWorkItem).not.toHaveBeenCalled();
    await expect(projects.getExecution("I_intake")).resolves.toMatchObject({ status: "intake" });
  });

  test("admits duplicate issue numbers from two linked repositories by global node identity", async () => {
    const projects = await storage();
    const prepareWorkItem = vi.fn(async input => ({ workItemId: input.workItemId }));
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: {
        listProjectItems: async () => [
          item("I_repo_a_42", 101, "rlabs88/repo-a"),
          item("I_repo_b_42", 202, "rlabs88/repo-b"),
        ],
        setStatus: vi.fn(),
      },
      commands: { prepareWorkItem } as unknown as FactoryAutomationCommandsPort,
      repositories: {
        resolveLinkedRepository: async input => ({ projectRepositoryId: `link-${input.repositoryDatabaseId}` }),
      },
      ownerId: "worker-1",
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({ admitted: 2 });
    expect(prepareWorkItem.mock.calls.map(call => call[0].contentNodeId))
      .toEqual(["I_repo_a_42", "I_repo_b_42"]);
  });

  test("moves an admitted Intake item to Investigate through the governed Factory transition", async () => {
    const projects = await storage();
    await projects.recordExecution({
      contentNodeId: "I_investigate", bindingId: "binding-1", projectItemNodeId: "PVTI_I_investigate",
      workItemId: "work-1", status: "intake",
    });
    const transitionWorkItem = vi.fn(async () => accepted("triage", 2));
    const setStatus = vi.fn();
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: {
        listProjectItems: async () => [item("I_investigate", 101, "rlabs88/repo-a", "investigate")],
        setStatus,
      },
      commands: {
        getWorkItem: vi.fn(async () => ({ stages: ["intake"], revision: 1 })),
        transitionWorkItem,
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({ transitioned: 1, projected: 0 });
    expect(transitionWorkItem).toHaveBeenCalledWith({
      orgId: "org-1",
      factoryProjectId: "factory-1",
      workItemId: "work-1",
      board: "work",
      stage: "triage",
      expectedRevision: 1,
      cause: "github_projects_status_sync",
      idempotencyKey: "I_investigate:triage:1",
    });
    expect(setStatus).not.toHaveBeenCalled();
    await expect(projects.getExecution("I_investigate")).resolves.toMatchObject({ status: "investigate" });
  });

  test("projects a Factory stage change back to GitHub instead of reversing it", async () => {
    const projects = await storage();
    await projects.recordExecution({
      contentNodeId: "I_factory_move", bindingId: "binding-1", projectItemNodeId: "PVTI_I_factory_move",
      workItemId: "work-1", status: "investigate",
    });
    const transitionWorkItem = vi.fn();
    const setStatus = vi.fn(async () => undefined);
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: {
        listProjectItems: async () => [item("I_factory_move", 101, "rlabs88/repo-a", "investigate")],
        setStatus,
      },
      commands: {
        getWorkItem: vi.fn(async () => ({ stages: ["planning"], revision: 3 })),
        transitionWorkItem,
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({ transitioned: 0, projected: 1 });
    expect(transitionWorkItem).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("PVTI_I_factory_move", "planning", expect.anything());
  });

  test("repairs rejected Project transitions to the actual Factory stage", async () => {
    const projects = await storage();
    await projects.recordExecution({
      contentNodeId: "I_rejected", bindingId: "binding-1", projectItemNodeId: "PVTI_I_rejected",
      workItemId: "work-1", status: "planning",
    });
    const setStatus = vi.fn(async () => undefined);
    const transitionWorkItem = vi.fn(async () => ({
      status: "rejected" as const,
      transitionId: "transition-rejected",
      itemId: "work-1",
      code: "invalid_transition" as const,
      reason: "Planning cannot move directly to Review",
    }));
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_rejected", 101, "rlabs88/repo-a", "review")], setStatus },
      commands: {
        getWorkItem: vi.fn(async () => ({ stages: ["planning"], revision: 4 })),
        transitionWorkItem,
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();
    expect(result.rejected).toEqual([expect.objectContaining({ reason: "transition_rejected:invalid_transition" })]);
    expect(setStatus).toHaveBeenCalledWith("PVTI_I_rejected", "planning", expect.anything());
  });

  test("re-reads Factory truth before repairing a stale rejected transition", async () => {
    const projects = await storage();
    await projects.recordExecution({
      contentNodeId: "I_stale", bindingId: "binding-1", projectItemNodeId: "PVTI_I_stale",
      workItemId: "work-1", status: "planning",
    });
    const setStatus = vi.fn(async () => undefined);
    const getWorkItem = vi.fn()
      .mockResolvedValueOnce({ stages: ["planning"], revision: 4 })
      .mockResolvedValueOnce({ stages: ["execute"], revision: 5 });
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_stale", 101, "rlabs88/repo-a", "review")], setStatus },
      commands: {
        getWorkItem,
        transitionWorkItem: vi.fn(async () => ({
          status: "rejected" as const,
          transitionId: "transition-stale",
          itemId: "work-1",
          code: "stale" as const,
          reason: "Factory advanced concurrently",
        })),
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await reconciler.runOnce();

    expect(getWorkItem).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenCalledWith("PVTI_I_stale", "building", expect.anything());
    await expect(projects.getExecution("I_stale")).resolves.toMatchObject({ status: "building" });
  });

  test("resolves concurrent status changes in favor of Factory and records a durable diagnostic", async () => {
    const projects = await storage();
    await projects.recordExecution({
      contentNodeId: "I_conflict", bindingId: "binding-1", projectItemNodeId: "PVTI_I_conflict",
      workItemId: "work-1", status: "intake",
    });
    const setStatus = vi.fn(async () => undefined);
    const transitionWorkItem = vi.fn();
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_conflict", 101, "rlabs88/repo-a", "investigate")], setStatus },
      commands: {
        getWorkItem: vi.fn(async () => ({ stages: ["planning"], revision: 3 })),
        transitionWorkItem,
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();

    expect(result.rejected).toEqual([
      expect.objectContaining({ contentNodeId: "I_conflict", reason: "concurrent_status_change_factory_won" }),
    ]);
    expect(transitionWorkItem).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("PVTI_I_conflict", "planning", expect.anything());
    await expect(projects.listDiagnostics("binding-1")).resolves.toEqual([
      expect.objectContaining({ contentNodeId: "I_conflict", reason: "concurrent_status_change_factory_won" }),
    ]);
  });

  test("requires Intake before any later Project stage", async () => {
    const projects = await storage();
    const setStatus = vi.fn(async () => undefined);
    const prepareWorkItem = vi.fn();
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_skipped_intake", 101, "rlabs88/repo-a", "building")], setStatus },
      commands: { prepareWorkItem } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();
    expect(prepareWorkItem).not.toHaveBeenCalled();
    expect(result.rejected).toEqual([expect.objectContaining({ reason: "intake_required" })]);
    expect(setStatus).toHaveBeenCalledWith("PVTI_I_skipped_intake", "backlog", expect.anything());
  });

  test("preserves the closed-content diagnostic when repairing a later status", async () => {
    const projects = await storage();
    const setStatus = vi.fn(async () => undefined);
    const open = item("I_closed", 101, "rlabs88/repo-a", "investigate");
    const closed = { ...open, content: { ...open.content, state: "CLOSED" as const } };
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [closed], setStatus },
      commands: { prepareWorkItem: vi.fn() } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();
    expect(result.rejected).toEqual([expect.objectContaining({ reason: "closed" })]);
    expect(setStatus).toHaveBeenCalledWith("PVTI_I_closed", "backlog", expect.anything());
  });

  test("does not transition a managed issue after GitHub closes it", async () => {
    const projects = await storage();
    await projects.recordExecution({
      contentNodeId: "I_managed_closed", bindingId: "binding-1", projectItemNodeId: "PVTI_I_managed_closed",
      workItemId: "work-1", status: "intake",
    });
    const open = item("I_managed_closed", 101, "rlabs88/repo-a", "investigate");
    const closed = { ...open, content: { ...open.content, state: "CLOSED" as const } };
    const setStatus = vi.fn(async () => undefined);
    const transitionWorkItem = vi.fn();
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [closed], setStatus },
      commands: {
        getWorkItem: vi.fn(async () => ({ stages: ["intake"], revision: 1 })),
        transitionWorkItem,
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();
    expect(result).toMatchObject({ transitioned: 0, projected: 1 });
    expect(result.rejected).toEqual([expect.objectContaining({ reason: "closed" })]);
    expect(transitionWorkItem).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("PVTI_I_managed_closed", "intake", expect.anything());
    await expect(projects.listDiagnostics("binding-1")).resolves.toEqual([
      expect.objectContaining({ contentNodeId: "I_managed_closed", reason: "closed" }),
    ]);
  });

  test("rejects unlinked repositories without admission", async () => {
    const projects = await storage();
    const prepareWorkItem = vi.fn();
    const setStatus = vi.fn();
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_unlinked", 303, "rlabs88/unlinked")], setStatus },
      commands: { prepareWorkItem } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => null },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();
    expect(result.rejected).toEqual([expect.objectContaining({ reason: "unlinked_repository" })]);
    expect(prepareWorkItem).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("PVTI_I_unlinked", "backlog", expect.anything());
    await expect(projects.listDiagnostics("binding-1")).resolves.toEqual([
      expect.objectContaining({ contentNodeId: "I_unlinked", reason: "unlinked_repository" }),
    ]);
  });

  test("prevents the same content node from admission into two bindings", async () => {
    const projects = await storage();
    const prepareWorkItem = vi.fn(async input => ({ workItemId: input.workItemId }));
    const bindings = [
      binding("binding-1", "factory-1", "PVT_1"),
      binding("binding-2", "factory-2", "PVT_2"),
    ];
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings,
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_shared", 101, "rlabs88/repo-a")], setStatus: vi.fn() },
      commands: { prepareWorkItem } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();
    expect(result.admitted).toBe(1);
    expect(result.existingExecutions).toBe(1);
    expect(prepareWorkItem).toHaveBeenCalledOnce();
  });

  test("persists relevant verified-event invalidations and deduplicates replay", async () => {
    const projects = await storage();
    const integration = createGithubProjectsFactoryIntegration({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [], setStatus: async () => undefined },
      ownerId: "worker-1",
    });

    await integration.observeVerifiedWebhook({ event: "issues", deliveryId: "ordinary", payload: {} });
    await integration.observeVerifiedWebhook({
      event: "projects_v2_item", deliveryId: "descriptive-field-only",
      payload: {
        projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_1" },
        changes: { field_value: { field_node_id: "execution" } },
      },
    });
    await integration.observeVerifiedWebhook({
      event: "projects_v2_item", deliveryId: "unbound",
      payload: { projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_other" } },
    });
    await integration.observeVerifiedWebhook({
      event: "projects_v2_item", deliveryId: "delivery-1",
      payload: { projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_1" } },
    });
    await integration.observeVerifiedWebhook({
      event: "projects_v2_item", deliveryId: "delivery-1",
      payload: { projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_1" } },
    });

    await expect(projects.listPendingReconciles()).resolves.toEqual([
      { id: expect.any(String), deliveryId: "delivery-1", event: "projects_v2_item", projectItemNodeId: "PVTI_1" },
    ]);
  });

  test("replays the same admission identity after an interrupted prepare", async () => {
    const projects = await storage();
    const prepareWorkItem = vi.fn()
      .mockRejectedValueOnce(new Error("interrupted after durable intent"))
      .mockImplementationOnce(async input => ({ workItemId: input.workItemId }));
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_replay", 101, "rlabs88/repo-a")], setStatus: vi.fn() },
      commands: {
        prepareWorkItem,
        getWorkItem: vi.fn(async () => null),
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await expect(reconciler.runOnce()).rejects.toThrow(/interrupted/i);
    await expect(projects.getExecution("I_replay")).resolves.toMatchObject({ status: "preparing" });
    await reconciler.runOnce();
    expect(prepareWorkItem).toHaveBeenCalledTimes(2);
    expect(prepareWorkItem.mock.calls[1]?.[0].workItemId).toBe(prepareWorkItem.mock.calls[0]?.[0].workItemId);
    expect(prepareWorkItem.mock.calls[1]?.[0].kickoffKey).toBe("github-project:I_replay");
  });

  test("passes Factory project defaults through the production integration", async () => {
    const projects = await storage();
    const prepareWorkItem = vi.fn(async input => ({ workItemId: input.workItemId }));
    const getProject = vi.fn(async () => ({ defaultModelId: "a1-proxy/code-workhorse-high" }));
    const integration = createGithubProjectsFactoryIntegration({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_model", 101, "rlabs88/repo-a")], setStatus: vi.fn() },
      ownerId: "worker-1",
    });
    integration.initializeAutomation({
      commands: { prepareWorkItem } as never,
    });
    const [worker] = integration.workers({
      storage: {
        projects: { get: getProject },
        sourceControlOwner: {
          repositories: { findByExternalId: vi.fn(async () => ({ id: "repo-1", slug: "rlabs88/repo-a" })) },
          connections: { list: vi.fn(async () => [{ id: "connection-1" }]) },
          projectRepositories: { list: vi.fn(async () => [{ id: "link-1", repositoryId: "repo-1" }]) },
        },
      },
    } as unknown as Parameters<typeof integration.workers>[0]);

    await worker?.start();
    await worker?.stop();

    expect(prepareWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      defaultModelId: "a1-proxy/code-workhorse-high",
    }));
  });
});
