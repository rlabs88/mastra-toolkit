---
kind: agent-instructions
version: 1
scope: "deployment/studio-server/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# Studio Server Deployment Policy

## Read first

- Read the root `AGENTS.md` and this folder's `CONTEXT.md`.
- Read `apps/studio` and every package checkpoint consumed by the deployed application.

## Operating rules

- Treat this folder as the future delivery boundary for the central Studio server.
- Keep application behavior in `apps/studio` and reusable runtime behavior in packages.
- Deliver secrets at runtime and keep health, rollback, persistence, and network policy explicit.

## Structure and activation

```text
deployment/studio-server/
├── AGENTS.md
└── CONTEXT.md
```

- Keep this checkpoint documentation-only until an approved activation issue names the operator and environment, selects exactly one container or VM strategy, and defines artifact identity, start and stop behavior, ports, health, shutdown, configuration, persistence, network, secrets, provenance, rollout, recovery, and the required structural-test amendment.
- When activated, add the minimum files for that strategy; do not pre-create dormant alternatives or generic deployment buckets.
- Extend this target while artifact, operator, trust boundary, persistence, and rollback remain one unit. Create a new deployment target only when those properties materially differ.
- Deployment owns packaging, manifests, environment policy, operations, and verification; `apps/studio` owns server behavior.

## Change boundaries

- Do not add deployment implementation until the activation contract above is complete.
- Do not copy application source or canonical configuration into deployment manifests.

## Validation

- Future changes must validate the built artifact, health endpoint, secret scan, persistence, and rollback path.

## Handoff

- Report the target environment, artifact identity, configuration source, health evidence, and rollback procedure.
