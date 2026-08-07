import { describe, expect, test, vi } from "vitest";
import {
  GithubProjectsGraphqlClient,
  createGithubGraphqlTransport,
  type GithubProjectBindingConfig,
} from "../src/index.js";

const binding: GithubProjectBindingConfig = {
  id: "binding-1", orgId: "org-1", factoryProjectId: "factory-1", githubOrganization: "rlabs88",
  githubProjectNodeId: "PVT_1", githubProjectNumber: 5, statusFieldId: "status",
  statusOptions: {
    backlog: "backlog", intake: "intake", investigate: "investigate", planning: "planning",
    building: "building", review: "review", done: "done", canceled: "canceled",
  },
  executionFieldId: "execution", executionOptions: { automatic: "auto", manual: "manual", hitl: "hitl" },
  workTypeFieldId: "workType",
  workTypeOptions: { implementation: "implementation", research: "research", prototype: "prototype", decision: "decision", map: "map" },
  enabled: true,
};

function queryItem(id: string) {
  return {
    id: `PVTI_${id}`,
    fieldValues: { nodes: [{ optionId: "intake", field: { id: "status" } }] },
    content: {
      __typename: "Issue", id, number: 1, title: id, url: `https://github.com/rlabs88/repo/issues/1`,
      state: "OPEN", repository: { id: "R_1", databaseId: 1, nameWithOwner: "rlabs88/repo" },
    },
  };
}

describe("GithubProjectsGraphqlClient", () => {
  test("paginates in Project connection order without querying a nonexistent item position", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ organization: { projectV2: {
        id: "PVT_1", items: { nodes: [queryItem("I_1")], pageInfo: { hasNextPage: true, endCursor: "next" } },
      } } })
      .mockResolvedValueOnce({ organization: { projectV2: {
        id: "PVT_1", items: { nodes: [queryItem("I_2")], pageInfo: { hasNextPage: false, endCursor: null } },
      } } });
    const client = new GithubProjectsGraphqlClient({ execute });

    const items = await client.listProjectItems(binding);

    expect(items.map(item => item.position)).toEqual([0, 1]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).not.toMatch(/\n\s*position\s*\n/);
    expect(execute.mock.calls[0]?.[0]).not.toContain("blockedBy");
    expect(execute.mock.calls[1]?.[1]).toMatchObject({ cursor: "next" });
  });

  test("sends the token only in authorization and surfaces GraphQL failures without echoing it", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer highly-sensitive-token" });
      return new Response(JSON.stringify({ errors: [{ message: "permission denied" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const transport = createGithubGraphqlTransport("highly-sensitive-token", request as typeof fetch);

    await expect(transport.execute("query Test { viewer { id } }", {})).rejects.toThrow("permission denied");
    await expect(transport.execute("query Test { viewer { id } }", {})).rejects.not.toThrow(/highly-sensitive-token/);
  });
});
