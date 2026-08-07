# Local Factory webhook ingress

This deployment target creates a temporary public HTTPS origin for GitHub App webhook testing against a local Factory server. It uses a credential-free Cloudflare Quick Tunnel and forwards to `http://host.docker.internal:4111`. Factory owns `/web/github/webhook` and rejects deliveries that do not carry a valid `X-Hub-Signature-256`; the tunnel never receives the GitHub webhook secret.

## Build and run

Start Factory on port 4111, then build and run the pinned image:

```bash
docker build \
  --file deployment/factory-webhook-ingress/Dockerfile \
  --tag mastra-toolkit/factory-webhook-ingress:test \
  deployment/factory-webhook-ingress

docker run --rm --name mastra-factory-webhook-ingress \
  mastra-toolkit/factory-webhook-ingress:test
```

Cloudflared prints a temporary `https://*.trycloudflare.com` origin. Configure the GitHub App callback as `<origin>/web/github/webhook`, send only the `projects_v2` and `projects_v2_item` events required for the test, and restore the prior callback immediately afterward. Stopping the container invalidates the origin.

The Factory origin must be reachable from the container. Some local development servers bind only to loopback even when they print `localhost:4111`; in that case, expose a temporary host-accessible forwarding port and override cloudflared's origin with `docker run ... mastra-toolkit/factory-webhook-ingress:test --url http://host.docker.internal:<port>`. Verify that port from a disposable container before opening the public tunnel. Do not expose the Factory origin directly to the internet.

## Security and verification

- The base image is pinned by the observed multi-platform digest `sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf`.
- No secret, Cloudflare account token, configuration file, volume, host network, or Docker socket is used.
- An unsigned POST to the public webhook URL must be rejected. A locally HMAC-signed Project delivery must receive Factory's accepted response and enqueue reconciliation.
- The 2026-08-07 local proof observed `401 Missing x-hub-signature-256` for an unsigned delivery and `202 {"ok":true,"ignored":true}` for a signed `projects_v2` delivery; the signed delivery also produced a durable reconcile record.
- Inspect `docker history --no-trunc mastra-toolkit/factory-webhook-ingress:test` before use; no credential value may appear.

This is not the production ingress. The central A1 listener and `webbs.renaissancelab.org` route remain owned by `homelab-toolkit`.
