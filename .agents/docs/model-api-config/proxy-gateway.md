# Proxy Gateway Model API Config

Mastra agents in this stack use the canonical `proxy` model gateway prefix.

## Canonical Model ID

Use:

```txt
proxy/openai/gpt-5.5
```

Do not use an `rl/` model prefix. The gateway ID registered by the Mastra server is `proxy`, so `proxy/openai/gpt-5.5` is the model ID Mastra should receive. The proxy gateway strips the gateway/provider namespace before sending the request upstream, so the hosted proxy receives:

```txt
gpt-5.5
```

## Environment

Use these project-facing env vars:

```txt
PROXY_BASE_URL=https://aa.renaissancelab.org/v1
PROXY_API_KEY=<proxy bearer key>
MASTRA_SUPERVISOR_MODEL=proxy/openai/gpt-5.5
```

Do not document or configure `RL_PROXY_BASE_URL`, `RL_PROXY_API_KEY`, or `rl/openai/...` in this stack. Older CLI stack env names may exist elsewhere, but the Mastra agent app should expose the neutral `PROXY_*` prefix.

## Verification

Verify the proxy key and model catalog:

```bash
node scripts/with-env.mjs node --input-type=module <<'NODE'
const baseUrl = process.env.PROXY_BASE_URL.replace(/\/+$/, '');
const response = await fetch(`${baseUrl}/models`, {
  headers: { Authorization: `Bearer ${process.env.PROXY_API_KEY}` },
});
const body = await response.json();
const models = body.data?.map((model) => model.id || model.name || model.model) ?? [];
console.log({
  ok: response.ok,
  hasGpt55: models.includes('gpt-5.5'),
});
NODE
```

Verify a direct completion smoke test:

```bash
node scripts/with-env.mjs node --input-type=module <<'NODE'
const baseUrl = process.env.PROXY_BASE_URL.replace(/\/+$/, '');
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.PROXY_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'Reply with exactly: proxy-ok' }],
    max_tokens: 12,
  }),
});
const body = await response.json();
console.log({
  ok: response.ok,
  content: body.choices?.[0]?.message?.content,
});
NODE
```
