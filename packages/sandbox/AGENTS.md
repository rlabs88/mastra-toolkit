---
kind: agent-instructions
version: 1
scope: "packages/sandbox/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# Sandbox Agent Policy

## Read first

- Read the repository [AGENTS.md](../../AGENTS.md) and this folder's [CONTEXT.md](CONTEXT.md).

## Operating rules

- Keep Local, Docker, and Platform adapters substitutable through the cloneable sandbox-machine contract.
- Keep provider selection explicit and fail when required provider identity is absent.
- Keep checked-in sandbox configuration free of credentials, host user state, and mutable image tags.

## Change boundaries

- Change sandbox schemas, package-local configuration, parser tests, and adapter contract tests together.
- Depend only on sandbox-owned narrow option types; do not import an aggregate application config.
- Do not grant Docker socket access or broaden local environment forwarding.

## Validation

- Run `npm test --prefix packages/sandbox` and `npm run typecheck --prefix packages/sandbox`.
- Confirm `git diff --check` and inspect configuration for credentials and mutable image references.

## Handoff

- State which provider or specification contract changed and list the package-local checks that ran.
