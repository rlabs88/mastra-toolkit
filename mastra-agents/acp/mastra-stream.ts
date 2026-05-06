function normalizeBaseUrl(baseUrl?: string): string { return (baseUrl ?? 'http://localhost:4111').replace(/\/+$/, ''); }
async function* parseSse(stream: ReadableStream<Uint8Array>) { const d=new TextDecoder(); let b=''; for await (const c of stream){ b+=d.decode(c,{stream:true}); let i; while((i=b.indexOf('\n\n'))!==-1){const blk=b.slice(0,i); b=b.slice(i+2); const data=blk.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n'); if(data) yield data;}} }

export async function* streamMastraAgent(baseUrl: string | undefined, agentId: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<unknown> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/agents/${encodeURIComponent(agentId)}/stream`;
  let response: Response;
  try {
    response = await fetch(url, { method:'POST', headers:{accept:'text/event-stream','content-type':'application/json'}, body:JSON.stringify(payload), signal });
  } catch (error) {
    throw new Error(`Mastra stream request failed for ${url}: ${errorMessage(error)}`);
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '');
    throw new Error(`Mastra stream failed for ${url}: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ''}`);
  }

  for await (const data of parseSse(response.body)) {
    if (data === '[DONE]') return;
    const chunk = JSON.parse(data);
    const streamError = mastraErrorMessage(chunk);
    if (streamError) throw new Error(`Mastra stream error: ${streamError}`);
    yield chunk;
  }
}

function mastraErrorMessage(chunk: unknown): string | undefined {
  if (!isRecord(chunk) || chunk.type !== 'error') return undefined;
  const payload = isRecord(chunk.payload) ? chunk.payload : undefined;
  const error = isRecord(payload?.error) ? payload.error : isRecord(chunk.error) ? chunk.error : undefined;
  return str(error?.message) ?? str(payload?.message) ?? str(chunk.message) ?? 'Unknown Mastra stream error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
