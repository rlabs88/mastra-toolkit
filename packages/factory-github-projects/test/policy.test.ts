import { describe, expect, test } from "vitest";
import {
  evaluateProjectItem,
  factoryStageForProjectStatus,
  loadGithubProjectsConfig,
  normalizeProjectItem,
  orderEligibleItems,
  projectStatusForFactoryStage,
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
    intake: "intake",
    investigate: "investigate",
    planning: "planning",
    building: "building",
    review: "review",
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
  test("validates stable status ids and permits Status-only Projects", () => {
    const environment = {
      GITHUB_PROJECTS_TOKEN: "secret-not-returned",
      GITHUB_PROJECTS_AUTOMATION_USER_ID: "local-user",
      GITHUB_PROJECTS_CONFIG: JSON.stringify({
        reconcileIntervalMs: 30_000,
        bindings: [{
          ...binding,
          executionFieldId: undefined,
          executionOptions: undefined,
          workTypeFieldId: undefined,
          workTypeOptions: undefined,
        }],
      }),
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

  test("rejects ambiguous field authority and partial optional-field configuration", () => {
    const configure = (bindings: unknown[]) => loadGithubProjectsConfig({
      GITHUB_PROJECTS_AUTOMATION_USER_ID: "local-user",
      GITHUB_PROJECTS_CONFIG: JSON.stringify({ reconcileIntervalMs: 30_000, bindings }),
    });

    expect(() => configure([{ ...binding, statusOptions: { ...binding.statusOptions, intake: "backlog" } }]))
      .toThrow(/status option IDs must be unique/i);
    expect(() => configure([{ ...binding, executionFieldId: binding.statusFieldId }]))
      .toThrow(/field IDs must be unique/i);
    expect(() => configure([{ ...binding, executionOptions: undefined }]))
      .toThrow(/configured together/i);
    expect(() => configure([{ ...binding, workTypeFieldId: undefined }]))
      .toThrow(/configured together/i);
    expect(() => configure([binding, { ...binding, factoryProjectId: "factory-2", githubProjectNodeId: "PVT_2" }]))
      .toThrow(/binding ID.*unique/i);
    expect(() => configure([{
      ...binding,
      workspacePolicies: [{ projectFieldOptionId: "workspace", projectRepositoryId: "repo" }],
    }])).toThrow(/workspacePolicies require workspaceFieldId/i);
  });

  test("uses Intake status and global node identity as admission authority", () => {
    const normalized = normalizeProjectItem(binding, {
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
        PVTF_status: "intake",
        PVTF_execution: "manual",
        PVTF_work_type: "decision",
      },
      position: 2,
      labels: ["status:backlog"],
    });

    expect(normalized.identity).toMatchObject({ contentNodeId: "I_global", number: 42 });
    expect(evaluateProjectItem(binding, normalized)).toEqual({ eligible: true });
  });

  test.each(["backlog", "investigate", "planning", "building", "review", "done", "canceled"])(
    "does not admit status=%s before Intake",
    status => {
      const normalized = normalizeProjectItem(binding, {
        projectItemNodeId: "PVTI_item",
        content: {
          type: "Issue", contentNodeId: "I_global", repositoryNodeId: "R_global",
          repositoryDatabaseId: 1, repositoryNameWithOwner: "a/b", number: 1,
          title: "Task", url: "https://github.com/a/b/issues/1", state: "OPEN",
        },
        fieldValues: { PVTF_status: status },
        position: 1,
      });
      expect(evaluateProjectItem(binding, normalized)).toEqual({ eligible: false, reason: "status_not_intake" });
    },
  );

  test("maps every Factory stage to the exact Project status and back", () => {
    expect(projectStatusForFactoryStage("intake")).toBe("intake");
    expect(projectStatusForFactoryStage("triage")).toBe("investigate");
    expect(projectStatusForFactoryStage("planning")).toBe("planning");
    expect(projectStatusForFactoryStage("execute")).toBe("building");
    expect(projectStatusForFactoryStage("review")).toBe("review");
    expect(projectStatusForFactoryStage("done")).toBe("done");
    expect(projectStatusForFactoryStage("canceled")).toBe("canceled");
    expect(factoryStageForProjectStatus(binding, "investigate")).toBe("triage");
    expect(factoryStageForProjectStatus(binding, "building")).toBe("execute");
    expect(factoryStageForProjectStatus(binding, "backlog")).toBeUndefined();
  });

  test("orders the Intake frontier deterministically", () => {
    const items = [
      { identity: { contentNodeId: "I_b" }, priority: 2, position: 1 },
      { identity: { contentNodeId: "I_a" }, priority: 1, position: 9 },
      { identity: { contentNodeId: "I_c" }, priority: 1, position: 2 },
    ] as never;
    expect(orderEligibleItems(items).map(item => item.identity.contentNodeId)).toEqual(["I_c", "I_a", "I_b"]);
  });
});
