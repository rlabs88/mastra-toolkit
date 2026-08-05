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

## Change boundaries

- Do not add deployment implementation until its dedicated issue defines the image owner, build pipeline, credential classes, and rollback contract.
- Never bake credentials, host state, Docker socket access, or user configuration into an image.

## Validation

- Future changes must validate the sandbox ABI, image provenance, secret scan, and Factory consumer contract.

## Handoff

- Report image identity, consumer, credential class, and rollback evidence when this boundary becomes active.
