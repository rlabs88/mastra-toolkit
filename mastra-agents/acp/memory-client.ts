type CloneThreadResponse = {
  thread?: {
    id?: unknown;
    resourceId?: unknown;
    metadata?: Record<string, unknown>;
  };
  clonedMessages?: unknown[];
};

export type CloneMastraThreadParams = {
  baseUrl?: string;
  agentId: string;
  sourceThreadId: string;
  newThreadId: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
};

export type ClonedMastraThread = {
  id: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
};

export async function cloneMastraThread(params: CloneMastraThreadParams): Promise<ClonedMastraThread> {
  const url = new URL(
    `/api/memory/threads/${encodeURIComponent(params.sourceThreadId)}/clone`,
    normalizeBaseUrl(params.baseUrl),
  );
  url.searchParams.set('agentId', params.agentId);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        newThreadId: params.newThreadId,
        resourceId: params.resourceId,
        metadata: params.metadata,
      }),
    });
  } catch (error) {
    throw new Error(`Mastra memory clone request failed for ${url}: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Mastra memory clone failed for ${url}: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ''}`);
  }

  const result = await response.json() as CloneThreadResponse;
  const id = typeof result.thread?.id === 'string' ? result.thread.id : undefined;
  const resourceId = typeof result.thread?.resourceId === 'string' ? result.thread.resourceId : undefined;
  if (!id || !resourceId) {
    throw new Error('Mastra memory clone response did not include thread.id and thread.resourceId');
  }

  return { id, resourceId, metadata: result.thread?.metadata };
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? 'http://localhost:4111').replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
