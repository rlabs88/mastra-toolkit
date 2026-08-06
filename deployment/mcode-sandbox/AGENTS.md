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
├── CONTEXT.md
├── Dockerfile
├── Dockerfile.dockerignore
├── README.md
├── build-validate.sh
├── credential-guard.sh
├── runtime/
│   ├── package-lock.json
│   └── package.json
├── runtime-probe.sh
└── verify-image.sh
```

- Issue #119 activated this boundary for the Factory sandbox fleet. Keep its consumer, package layers, entrypoint ABI, credential classes, operator, health checks, and rollback contract synchronized with `README.md` and the issue record.
- Add only files required by the activated delivery slice. Reference package and application contracts instead of copying their implementation or configuration.
- Require immutable provenance, runtime-only secrets, least privilege, no Docker socket or host credentials, and rollback to a known-good release including persistent-state and in-flight-work handling.

## Change boundaries

- Never bake credentials, host state, Docker socket access, or user configuration into an image.
- Keep the AES and OPS bases immutable. Version changes must update their digest evidence and validate both final profiles.
- Consume profile names, package layers, lifecycle, and credential policy from `packages/sandbox/config/runtime-profiles.json`; do not add another deployment-owned profile manifest.
- Hosted CI may validate source contracts but must not publish these native ARM64 images. Publication and live reconciliation remain OPS-owned actions.

## Validation

- Validate the sandbox ABI, installed profile and selected image identity, clean-source provenance, secret scan, real Mastra workflow execution, and Factory consumer contract.
- Run `./build-validate.sh` on a native ARM64 host with Docker before publishing either image.

## Handoff

- Report image identity, consumer, credential class, and rollback evidence when this boundary becomes active.
