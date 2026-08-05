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

- Treat this folder as delivery configuration for the central Studio server, whether container- or VM-hosted.
- Keep application behavior in `apps/studio` and reusable runtime behavior in packages.
- Deliver secrets at runtime and keep health, rollback, persistence, and network policy explicit.

## Change boundaries

- Do not add Docker or VM implementation until its dedicated deployment issue defines the target environment and operations contract.
- Do not copy application source or canonical configuration into deployment manifests.

## Validation

- Future changes must validate the built artifact, health endpoint, secret scan, persistence, and rollback path.

## Handoff

- Report the target environment, artifact identity, configuration source, health evidence, and rollback procedure.
