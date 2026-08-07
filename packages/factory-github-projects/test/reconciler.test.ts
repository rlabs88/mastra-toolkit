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
  backlog: "backlog", ready: "ready", inProgress: "progress",
  validating: "validating", done: "done", canceled: "canceled",
} as const;
function binding(id: string, factoryProjectId: string, projectNodeId: string): GithubProjectBindingConfig {
  return {
    id, orgId: "org-1", factoryProjectId, githubOrganization: "rlabs88",
    githubProjectNodeId: projectNodeId, githubProjectNumber: Number(id.at(-1) ?? 1),
    statusFieldId: "status", statusOptions: options,
    executionFieldId: "execution", executionOptions: { automatic: "auto", manual: "manual", hitl: "hitl" },
    workTypeFieldId: "workType",
    workTypeOptions: { implementation: "implementation", research: "research", prototype: "prototype", decision: "decision", map: "map" },
    enabled: true,
  };
}
function item(contentNodeId: string, repositoryDatabaseId: number, repository: string): GithubProjectItemSnapshot {
  return {
    projectItemNodeId: `PVTI_${contentNodeId}`,
    content: {
      type: "Issue", contentNodeId, repositoryNodeId: `R_${repositoryDatabaseId}`,
      repositoryDatabaseId, repositoryNameWithOwner: repository, number: 42,
      title: `Issue in ${repository}`, url: `https://github.com/${repository}/issues/42`, state: "OPEN",
    },
    fieldValues: { status: "ready", execution: "auto", workType: "implementation" },
    position: 1,
    blockedByOpenCount: 0,
  };
}
async function storage() {
  const root = new LibSQLFactoryStorage({ id: `reconciler-${stores.length}`, url: ":memory:" });
  stores.push(root);
  const projects = root.registerDomain(new GithubProjectsStorage());
  await root.init();
  return projects;
}

describe("GithubProjectsReconciler", () => {
  test("starts duplicate issue numbers from two linked repositories by global node identity", async () => {
    const projects = await storage();
    const startWorkItem = vi.fn(async input => ({ workItemId: input.workItemId }));
    const setStatus = vi.fn(async (_itemId: string, _status: string) => undefined);
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 2,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_repo_a_42", 101, "rlabs88/repo-a"), item("I_repo_b_42", 202, "rlabs88/repo-b")], setStatus },
      commands: {
        startWorkItem,
        getWorkItem: vi.fn(async () => ({ stages: ["execute"] })),
      } as unknown as FactoryAutomationCommandsPort,
      repositories: {
        resolveLinkedRepository: async input => ({ projectRepositoryId: `link-${input.repositoryDatabaseId}` }),
      },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();

    expect(result.started).toBe(2);
    expect(startWorkItem).toHaveBeenCalledTimes(2);
    expect(startWorkItem.mock.calls.map(call => call[0].contentNodeId)).toEqual(["I_repo_a_42", "I_repo_b_42"]);
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus.mock.calls.every(call => call[1] === "progress")).toBe(true);
  });

  test("adopts the Factory-assigned work item identity after a governed start", async () => {
    const projects = await storage();
    const startWorkItem = vi.fn(async () => ({ workItemId: "factory-assigned-work-item" }));
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: {
        listProjectItems: async () => [item("I_authoritative", 101, "rlabs88/repo-a")],
        setStatus: vi.fn(async () => undefined),
      },
      commands: {
        startWorkItem,
        getWorkItem: vi.fn(async () => ({ stages: ["execute"] })),
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({ started: 1 });
    await expect(projects.getExecution("I_authoritative")).resolves.toMatchObject({
      workItemId: "factory-assigned-work-item",
      status: "active",
    });
  });

  test("passes the Factory project default model into governed starts", async () => {
    const projects = await storage();
    const startWorkItem = vi.fn(async input => ({ workItemId: input.workItemId }));
    const resolveDefaultModelId = vi.fn(async () => "a1-proxy/code-workhorse-high");
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: {
        listProjectItems: async () => [item("I_model", 101, "rlabs88/repo-a")],
        setStatus: vi.fn(async () => undefined),
      },
      commands: {
        startWorkItem,
        getWorkItem: vi.fn(async () => ({ stages: ["execute"] })),
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      factoryProjects: { resolveDefaultModelId },
      ownerId: "worker-1",
    });

    await reconciler.runOnce();

    expect(startWorkItem).toHaveBeenCalledOnce();
    expect(resolveDefaultModelId).toHaveBeenCalledWith({ orgId: "org-1", factoryProjectId: "factory-1" });
    expect(startWorkItem.mock.calls[0]?.[0].defaultModelId).toBe("a1-proxy/code-workhorse-high");
  });

  test("wires the Factory project default model through the production integration", async () => {
    const projects = await storage();
    const startWorkItem = vi.fn(async input => ({ workItemId: input.workItemId }));
    const getProject = vi.fn(async () => ({ defaultModelId: "a1-proxy/code-workhorse-high" }));
    const integration = createGithubProjectsFactoryIntegration({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: {
        listProjectItems: async () => [item("I_integrated_model", 101, "rlabs88/repo-a")],
        setStatus: vi.fn(async () => undefined),
      },
      ownerId: "worker-1",
    });
    integration.initializeAutomation({
      commands: {
        startWorkItem,
        getWorkItem: vi.fn(async () => ({ stages: ["execute"] })),
      } as unknown as FactoryAutomationCommandsPort,
    });
    const [worker] = integration.workers({
      storage: {
        projects: { get: getProject },
        sourceControlOwner: {
          repositories: {
            findByExternalId: vi.fn(async () => ({ id: "repo-1", slug: "rlabs88/repo-a" })),
          },
          connections: {
            list: vi.fn(async () => [{ id: "connection-1" }]),
          },
          projectRepositories: {
            list: vi.fn(async () => [{ id: "link-1", repositoryId: "repo-1" }]),
          },
        },
      },
    } as unknown as Parameters<typeof integration.workers>[0]);

    await worker?.start();
    await worker?.stop();

    expect(getProject).toHaveBeenCalledWith({ orgId: "org-1", id: "factory-1" });
    expect(startWorkItem).toHaveBeenCalledOnce();
    expect(startWorkItem.mock.calls[0]?.[0].defaultModelId).toBe("a1-proxy/code-workhorse-high");
  });

  test("rejects unlinked repositories without starting or projecting status", async () => {
    const projects = await storage();
    const startWorkItem = vi.fn();
    const setStatus = vi.fn();
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_unlinked", 303, "rlabs88/unlinked")], setStatus },
      commands: { startWorkItem } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => null },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();

    expect(result.rejected).toEqual([{ bindingId: "binding-1", contentNodeId: "I_unlinked", reason: "unlinked_repository" }]);
    expect(startWorkItem).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    await expect(projects.listDiagnostics()).resolves.toEqual([
      expect.objectContaining({ bindingId: "binding-1", contentNodeId: "I_unlinked", reason: "unlinked_repository" }),
    ]);
  });

  test("prevents the same content node from starting in two bound Projects", async () => {
    const projects = await storage();
    const startWorkItem = vi.fn(async input => ({ workItemId: input.workItemId }));
    const same = item("I_shared", 101, "rlabs88/repo-a");
    const bindings = [binding("binding-1", "factory-1", "PVT_1"), binding("binding-2", "factory-2", "PVT_2")];
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 2, maxConcurrentItemsPerProject: 1, bindings,
      },
      storage: projects,
      github: { listProjectItems: async () => [same], setStatus: vi.fn(async () => undefined) },
      commands: {
        startWorkItem,
        getWorkItem: vi.fn(async () => ({ stages: ["execute"] })),
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    const result = await reconciler.runOnce();

    expect(result.started).toBe(1);
    expect(result.existingExecutions).toBe(1);
    expect(startWorkItem).toHaveBeenCalledOnce();
  });

  test("persists only Projects V2 verified-event invalidations and deduplicates replay", async () => {
    const projects = await storage();
    const integration = createGithubProjectsFactoryIntegration({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [], setStatus: async () => undefined },
      ownerId: "worker-1",
    });

    await integration.observeVerifiedWebhook({ event: "issues", deliveryId: "ordinary", payload: {} });
    await integration.observeVerifiedWebhook({
      event: "projects_v2_item", deliveryId: "unbound", payload: {
        projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_other" },
      },
    });
    await integration.observeVerifiedWebhook({
      event: "projects_v2_item", deliveryId: "unrelated-field", payload: {
        projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_1" },
        changes: { field_value: { field_node_id: "PVTF_unrelated" } },
      },
    });
    await integration.observeVerifiedWebhook({
      event: "projects_v2_item", deliveryId: "delivery-1", payload: {
        projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_1" },
      },
    });
    await integration.observeVerifiedWebhook({
      event: "projects_v2_item", deliveryId: "delivery-1", payload: {
        projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_1" },
      },
    });

    await expect(projects.listPendingReconciles()).resolves.toEqual([
      { id: expect.any(String), deliveryId: "delivery-1", event: "projects_v2_item", projectItemNodeId: "PVTI_1" },
    ]);
  });

  test("completes durable webhook invalidations only after a successful recovery scan", async () => {
    const projects = await storage();
    await projects.enqueueReconcile({
      deliveryId: "delivery-restart", event: "projects_v2_item", projectItemNodeId: "PVTI_restart",
    });
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [], setStatus: async () => undefined },
      commands: { startWorkItem: vi.fn() } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => null },
      ownerId: "worker-1",
    });

    await reconciler.runOnce();

    await expect(projects.listPendingReconciles()).resolves.toEqual([]);
  });

  test("projects authoritative Factory lifecycle stages back to configured status option IDs", async () => {
    const projects = await storage();
    await projects.recordExecution({
      contentNodeId: "I_lifecycle", bindingId: "binding-1", projectItemNodeId: "PVTI_I_lifecycle",
      workItemId: "work-lifecycle", status: "active",
    });
    const setStatus = vi.fn(async () => undefined);
    const getWorkItem = vi.fn(async () => ({ stages: ["review"] }));
    const managedItem = {
      ...item("I_lifecycle", 101, "rlabs88/repo-a"),
      fieldValues: { status: "progress", execution: "auto", workType: "implementation" },
    };
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [managedItem], setStatus },
      commands: { getWorkItem } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await reconciler.runOnce();
    expect(setStatus).toHaveBeenLastCalledWith("PVTI_I_lifecycle", "validating", expect.anything());

    getWorkItem.mockResolvedValueOnce({ stages: ["done"] });
    await reconciler.runOnce();
    expect(setStatus).toHaveBeenLastCalledWith("PVTI_I_lifecycle", "done", expect.anything());
  });

  test("coalesces overlapping scans so one issue starts once", async () => {
    const projects = await storage();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const startWorkItem = vi.fn(async input => {
      await gate;
      return { workItemId: input.workItemId };
    });
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_once", 101, "rlabs88/repo-a")], setStatus: vi.fn() },
      commands: { startWorkItem, getWorkItem: vi.fn(async () => null) } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    const first = reconciler.runOnce();
    const second = reconciler.runOnce();
    await vi.waitFor(() => expect(startWorkItem).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(startWorkItem).toHaveBeenCalledOnce();
  });

  test("counts active Factory work against per-project and cross-project concurrency", async () => {
    const projects = await storage();
    await projects.recordExecution({
      contentNodeId: "I_active", bindingId: "binding-1", projectItemNodeId: "PVTI_I_active",
      workItemId: "work-active", status: "active",
    });
    const startWorkItem = vi.fn(async input => ({ workItemId: input.workItemId }));
    const bindings = [binding("binding-1", "factory-1", "PVT_1"), binding("binding-2", "factory-2", "PVT_2")];
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1, bindings,
      },
      storage: projects,
      github: {
        listProjectItems: async current => current.id === "binding-1"
          ? [item("I_active", 101, "rlabs88/repo-a"), item("I_waiting_1", 101, "rlabs88/repo-a")]
          : [item("I_waiting_2", 202, "rlabs88/repo-b")],
        setStatus: vi.fn(),
      },
      commands: {
        startWorkItem,
        getWorkItem: vi.fn(async () => ({ stages: ["execute"] })),
      } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await reconciler.runOnce();
    expect(startWorkItem).not.toHaveBeenCalled();
  });

  test("records stable ownership before start and replays the same work item after interruption", async () => {
    const projects = await storage();
    const startWorkItem = vi.fn()
      .mockRejectedValueOnce(new Error("interrupted after durable intent"))
      .mockImplementationOnce(async input => ({ workItemId: input.workItemId }));
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [item("I_replay", 101, "rlabs88/repo-a")], setStatus: vi.fn() },
      commands: { startWorkItem, getWorkItem: vi.fn(async () => null) } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await expect(reconciler.runOnce()).rejects.toThrow(/interrupted/i);
    const intent = await projects.getExecution("I_replay");
    expect(intent?.status).toBe("starting");
    await reconciler.runOnce();
    expect(startWorkItem).toHaveBeenCalledTimes(2);
    expect(startWorkItem.mock.calls[1]?.[0].workItemId).toBe(startWorkItem.mock.calls[0]?.[0].workItemId);
    expect(startWorkItem.mock.calls[1]?.[0].kickoffKey).toBe("github-project:I_replay");
  });

  test("does not write a Project status that already matches Factory", async () => {
    const projects = await storage();
    await projects.recordExecution({
      contentNodeId: "I_current", bindingId: "binding-1", projectItemNodeId: "PVTI_I_current",
      workItemId: "work-current", status: "active",
    });
    const setStatus = vi.fn();
    const reconciler = new GithubProjectsReconciler({
      config: {
        automationUserId: "local-user", reconcileIntervalMs: 30_000,
        maxConcurrentProjects: 1, maxConcurrentItemsPerProject: 1,
        bindings: [binding("binding-1", "factory-1", "PVT_1")],
      },
      storage: projects,
      github: { listProjectItems: async () => [{
        ...item("I_current", 101, "rlabs88/repo-a"),
        fieldValues: { status: "progress", execution: "auto", workType: "implementation" },
      }], setStatus },
      commands: { getWorkItem: vi.fn(async () => ({ stages: ["execute"] })) } as unknown as FactoryAutomationCommandsPort,
      repositories: { resolveLinkedRepository: async () => ({ projectRepositoryId: "link-1" }) },
      ownerId: "worker-1",
    });

    await reconciler.runOnce();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
