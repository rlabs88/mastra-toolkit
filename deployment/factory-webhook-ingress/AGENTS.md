---
kind: agent-instructions
version: 1
scope: "deployment/factory-webhook-ingress/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# Local Factory Webhook Ingress Policy

- Read `CONTEXT.md` before changing this target.
- Keep this target temporary, local, credential-free, and limited to forwarding public HTTPS traffic to the signature-verifying Factory GitHub webhook route.
- Pin the Cloudflare Tunnel base by digest. Never add a tunnel token, GitHub secret, origin credential, host state, or Docker socket.
- Keep permanent A1 ingress configuration in `homelab-toolkit`; this target must not become a second production ingress owner.
- Docker Compose and Factory server packaging are outside this boundary.
