import { describe, expect, test } from "vitest";
import {
  evaluateProjectItem,
  loadGithubProjectsConfig,
  normalizeProjectItem,
  orderEligibleItems,
  projectStatusForFactoryState,
} from "../src/index.js";

const binding = {
  id: "binding-1",
  orgId: "org-1",
  factoryProjectId: "factory-1",
  githubOrganization: "rlabs88",
  githubProjectNodeId: "PVT_project",
  githubProjectNumber: 5,
  statusFieldId: "PVTF_status",
  statusOptions: {
    backlog: "backlog",
    ready: "ready",
    inProgress: "progress",
    validating: "validating",
    done: "done",
    canceled: "canceled",
  },
  executionFieldId: "PVTF_execution",
  executionOptions: { automatic: "automatic", manual: "manual", hitl: "hitl" },
  workTypeFieldId: "PVTF_work_type",
  workTypeOptions: {
    implementation: "implementation",
    research: "research",
    prototype: "prototype",
    decision: "decision",
    map: "map",
  },
  enabled: true,
} as const;

describe("Projects V2 policy", () => {
  test("validates stable field and option ids and rejects duplicate Factory bindings", () => {
    const environment = {
      GITHUB_PROJECTS_TOKEN: "secret-not-returned",
      GITHUB_PROJECTS_AUTOMATION_USER_ID: "local-user",
      GITHUB_PROJECTS_CONFIG: JSON.stringify({ reconcileIntervalMs: 30_000, bindings: [binding] }),
    };
    const loaded = loadGithubProjectsConfig(environment);
    expect(loaded?.config.bindings).toHaveLength(1);
    expect(JSON.stringify(loaded)).not.toContain("secret-not-returned");
    expect(() => loadGithubProjectsConfig({
      ...environment,
      GITHUB_PROJECTS_CONFIG: JSON.stringify({
        reconcileIntervalMs: 30_000,
        bindings: [binding, { ...binding, id: "binding-2", githubProjectNodeId: "PVT_other" }],
      }),
    })).toThrow(/Factory project.*one GitHub Project/i);
  });

  test("rejects ambiguous field authority, duplicate binding identities, and unenforced workspace restrictions", () => {
    const environment = {
      GITHUB_PROJECTS_TOKEN: "secret-not-returned",
      GITHUB_PROJECTS_AUTOMATION_USER_ID: "local-user",
      GITHUB_PROJECTS_CONFIG: "",
    };
    const configure = (bindings: unknown[]) => loadGithubProjectsConfig({
      ...environment,
      GITHUB_PROJECTS_CONFIG: JSON.stringify({ reconcileIntervalMs: 30_000, bindings }),
    });

    expect(() => configure([{ ...binding, statusOptions: { ...binding.statusOptions, ready: "backlog" } }]))
      .toThrow(/status option IDs must be unique/i);
    expect(() => configure([{ ...binding, executionFieldId: binding.statusFieldId }]))
      .toThrow(/field IDs must be unique/i);
    expect(() => configure([binding, { ...binding, factoryProjectId: "factory-2", githubProjectNodeId: "PVT_2" }]))
      .toThrow(/binding ID.*unique/i);
    expect(() => configure([{ ...binding, workspacePolicies: [{ projectFieldOptionId: "workspace", projectRepositoryId: "repo" }] }]))
      .toThrow(/workspacePolicies require workspaceFieldId/i);
    expect(() => configure([{
      ...binding,
      workspaceFieldId: "PVTF_workspace",
      workspacePolicies: [{ projectFieldOptionId: "workspace", projectRepositoryId: "repo", allowedPaths: ["packages/a"] }],
    }])).toThrow(/workspace execution restrictions are unsupported/i);
  });

  test("uses global node identity and field option ids without label authority", () => {
    const item = normalizeProjectItem(binding, {
      projectItemNodeId: "PVTI_item",
      content: {
        type: "Issue",
        contentNodeId: "I_global",
        repositoryNodeId: "R_global",
        repositoryDatabaseId: 42,
        repositoryNameWithOwner: "rlabs88/mastra-toolkit",
        number: 42,
        title: "Implement scheduler",
        url: "https://github.com/rlabs88/mastra-toolkit/issues/42",
        state: "OPEN",
      },
      fieldValues: {
        PVTF_status: "ready",
        PVTF_execution: "automatic",
        PVTF_work_type: "implementation",
      },
      position: 2,
      blockedByOpenCount: 0,
      labels: ["status:backlog"],
    });

    expect(item.identity).toMatchObject({ contentNodeId: "I_global", number: 42 });
    expect(evaluateProjectItem(binding, item)).toEqual({ eligible: true, role: "work" });
  });

  test.each([
    ["backlog", "automatic", 0, "status_not_ready"],
    ["ready", "manual", 0, "execution_not_automatic"],
    ["ready", "hitl", 0, "execution_not_automatic"],
    ["ready", "automatic", 1, "blocked"],
  ])("rejects status=%s execution=%s blocked=%s", (status, execution, blocked, reason) => {
    const item = normalizeProjectItem(binding, {
      projectItemNodeId: "PVTI_item",
      content: {
        type: "Issue", contentNodeId: "I_global", repositoryNodeId: "R_global",
        repositoryDatabaseId: 1, repositoryNameWithOwner: "a/b", number: 1,
        title: "Task", url: "https://github.com/a/b/issues/1", state: "OPEN",
      },
      fieldValues: {
        PVTF_status: status,
        PVTF_execution: execution,
        PVTF_work_type: "implementation",
      },
      position: 1,
      blockedByOpenCount: blocked,
    });
    expect(evaluateProjectItem(binding, item)).toEqual({ eligible: false, reason });
  });

  test("orders the dependency frontier deterministically", () => {
    const items = [
      { identity: { contentNodeId: "I_b" }, priority: 2, position: 1 },
      { identity: { contentNodeId: "I_a" }, priority: 1, position: 9 },
      { identity: { contentNodeId: "I_c" }, priority: 1, position: 2 },
    ] as never;
    expect(orderEligibleItems(items).map(item => item.identity.contentNodeId)).toEqual(["I_c", "I_a", "I_b"]);
  });

  test("projects accepted Factory lifecycle states to Project Status", () => {
    expect(projectStatusForFactoryState("queued")).toBe("backlog");
    expect(projectStatusForFactoryState("active")).toBe("inProgress");
    expect(projectStatusForFactoryState("validating")).toBe("validating");
    expect(projectStatusForFactoryState("verified-complete")).toBe("done");
    expect(projectStatusForFactoryState("canceled")).toBe("canceled");
  });
});
