function normalizeBaseUrl(baseUrl) { return (baseUrl ?? 'http://localhost:4111').replace(/\/+$/, ''); }
async function* parseSse(stream) { const d = new TextDecoder(); let b = ''; for await (const c of stream) {
    b += d.decode(c, { stream: true });
    let i;
    while ((i = b.indexOf('\n\n')) !== -1) {
        const blk = b.slice(0, i);
        b = b.slice(i + 2);
        const data = blk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data)
            yield data;
    }
} }
export async function* streamMastraAgent(baseUrl, agentId, payload, signal) {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/agents/${agentId}/stream`, { method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
    if (!response.ok || !response.body)
        throw new Error(`Mastra stream failed: ${response.status} ${response.statusText}`);
    for await (const data of parseSse(response.body)) {
        if (data === '[DONE]')
            return;
        yield JSON.parse(data);
    }
}
