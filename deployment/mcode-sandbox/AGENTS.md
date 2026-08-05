---
kind: agent-instructions
version: 1
scope: "deployment/mcode-sandbox/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# MCode Sandbox Deployment Policy

## Read first

- Read the root `AGENTS.md` and this folder's `CONTEXT.md`.
- Read `packages/sandbox/AGENTS.md` before defining a deployable sandbox contract.

## Operating rules

- Treat this folder as deployment input for a Factory-managed sandbox that runs MCode and approved agent tools.
- Keep runtime implementation in packages and application composition in `apps/mcode`.
- Use immutable images, runtime secret delivery, least privilege, and an explicit entrypoint ABI.

## Structure and activation

```text
deployment/mcode-sandbox/
├── AGENTS.md
└── CONTEXT.md
```

- Keep this checkpoint documentation-only until an approved activation issue names the Factory consumer and operator, entrypoint ABI, canonical-image decision, credential classes, publisher and build pipeline, rollout and health checks, rollback behavior, and required structural-test amendment.
- When activated, add only the files required by that concrete delivery slice. Reference package and application contracts instead of copying their implementation or configuration.
- Require immutable provenance, runtime-only secrets, least privilege, no Docker socket or host credentials, and rollback to a known-good release including persistent-state and in-flight-work handling.

## Change boundaries

- Do not add deployment implementation until the activation contract above is complete.
- Never bake credentials, host state, Docker socket access, or user configuration into an image.

## Validation

- Future changes must validate the sandbox ABI, image provenance, secret scan, and Factory consumer contract.

## Handoff

- Report image identity, consumer, credential class, and rollback evidence when this boundary becomes active.
