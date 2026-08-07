import type { GithubProjectBindingConfig, GithubProjectItemSnapshot } from "./types.js";

export interface GithubProjectsPort {
  listProjectItems(binding: GithubProjectBindingConfig): Promise<readonly GithubProjectItemSnapshot[]>;
  setStatus(
    projectItemNodeId: string,
    statusOptionId: string,
    binding: GithubProjectBindingConfig,
  ): Promise<void>;
}

export interface GithubGraphqlTransport {
  execute<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export class GithubProjectsGraphqlClient implements GithubProjectsPort {
  constructor(private readonly transport: GithubGraphqlTransport) {}

  async listProjectItems(binding: GithubProjectBindingConfig): Promise<GithubProjectItemSnapshot[]> {
    const items: GithubProjectItemSnapshot[] = [];
    let cursor: string | null = null;
    do {
      const page: ProjectItemsQuery = await this.transport.execute<ProjectItemsQuery>(PROJECT_ITEMS_QUERY, {
        organization: binding.githubOrganization,
        number: binding.githubProjectNumber,
        cursor,
      });
      const project = page.organization?.projectV2;
      if (!project || project.id !== binding.githubProjectNodeId) {
        throw new Error(`Configured GitHub Project '${binding.githubProjectNodeId}' was not found`);
      }
      for (const node of project.items.nodes ?? []) {
        if (node.fieldValues.pageInfo?.hasNextPage || node.content?.blockedBy?.pageInfo?.hasNextPage) {
          throw new Error(`GitHub Project item '${node.id}' exceeds the supported field or dependency page size`);
        }
        const content = normalizeContent(node.content);
        if (!content) continue;
        const fieldValues: Record<string, string | number | null> = {};
        for (const field of node.fieldValues.nodes ?? []) {
          const fieldId = field.field?.id;
          if (!fieldId) continue;
          fieldValues[fieldId] = field.optionId ?? field.number ?? null;
        }
        items.push({
          projectItemNodeId: node.id,
          content,
          fieldValues,
          position: items.length,
          blockedByOpenCount: node.content?.blockedBy?.nodes?.filter(issue => issue.state === "OPEN").length ?? 0,
        });
      }
      cursor = project.items.pageInfo.hasNextPage ? (project.items.pageInfo.endCursor ?? null) : null;
    } while (cursor);
    return items;
  }

  async setStatus(
    projectItemNodeId: string,
    statusOptionId: string,
    binding: GithubProjectBindingConfig,
  ): Promise<void> {
    await this.transport.execute(UPDATE_SINGLE_SELECT_QUERY, {
      projectId: binding.githubProjectNodeId,
      itemId: projectItemNodeId,
      fieldId: binding.statusFieldId,
      optionId: statusOptionId,
    });
  }
}

export function createGithubGraphqlTransport(
  token: string,
  fetchImplementation: typeof fetch = fetch,
): GithubGraphqlTransport {
  if (!token.trim()) throw new Error("GitHub Projects GraphQL token is required");
  return {
    async execute<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const response = await fetchImplementation("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
      if (!response.ok || body.errors?.length || !body.data) {
        const message = body.errors?.map(error => error.message).filter(Boolean).join("; ")
          || `GitHub GraphQL request failed (${response.status})`;
        throw new Error(message);
      }
      return body.data;
    },
  };
}

interface ProjectItemsQuery {
  organization: {
    projectV2: {
      id: string;
      items: {
        nodes: Array<{
          id: string;
          content?: QueryContent | null;
          fieldValues: { nodes?: QueryFieldValue[]; pageInfo?: { hasNextPage: boolean } };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
      };
    } | null;
  } | null;
}
interface QueryContent {
  __typename: string;
  id: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  repository?: { id: string; databaseId?: number | null; nameWithOwner: string };
  blockedBy?: { nodes?: Array<{ state: string }>; pageInfo?: { hasNextPage: boolean } };
}
interface QueryFieldValue {
  optionId?: string | null;
  number?: number | null;
  field?: { id?: string | null } | null;
}

function normalizeContent(content: QueryContent | null | undefined): GithubProjectItemSnapshot["content"] | null {
  if (!content) return null;
  const repository = content.repository;
  if (
    (content.__typename !== "Issue" && content.__typename !== "PullRequest")
    || !repository || !content.number || !content.title || !content.url || !repository.databaseId
  ) return null;
  const type: "Issue" | "PullRequest" = content.__typename;
  return {
    type,
    contentNodeId: content.id,
    repositoryNodeId: repository.id,
    repositoryDatabaseId: repository.databaseId,
    repositoryNameWithOwner: repository.nameWithOwner,
    number: content.number,
    title: content.title,
    url: content.url,
    state: content.state === "OPEN" ? "OPEN" : "CLOSED",
  };
}

const PROJECT_ITEMS_QUERY = `
query FactoryProjectItems($organization: String!, $number: Int!, $cursor: String) {
  organization(login: $organization) {
    projectV2(number: $number) {
      id
      items(first: 100, after: $cursor, orderBy: { field: POSITION, direction: ASC }) {
        nodes {
          id
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
            }
            pageInfo { hasNextPage }
          }
          content {
            __typename
            ... on Issue {
              id number title url state repository { id databaseId nameWithOwner }
              blockedBy(first: 100) { nodes { state } pageInfo { hasNextPage } }
            }
            ... on PullRequest { id number title url state repository { id databaseId nameWithOwner } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const UPDATE_SINGLE_SELECT_QUERY = `
mutation FactorySetProjectStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}`;
