---
kind: checkpoint-context
version: 1
scope: "deployment/factory-webhook-ingress/**"
status: active
---

# Local Factory Webhook Ingress Context

## Past

Local Factory development relied on polling because GitHub could not deliver Project events to a loopback-only server.

## Present

This target wraps Cloudflare's credential-free Quick Tunnel client in an immutable local image. It forwards a temporary public HTTPS origin to `host.docker.internal:4111`; Factory remains the only HTTP application and verifies every GitHub webhook signature at `/web/github/webhook`. The image contains no listener implementation, credentials, or persisted tunnel identity.

## Future

Production ingress belongs to the central A1 listener at `webbs.renaissancelab.org` and its explicit tailnet upstream route in `homelab-toolkit`. Retire this local target when that route is deployed and freshly verified.
