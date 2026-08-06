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
- Keep runtime profile names, lifecycle, package layers, and credential classes canonical in `config/runtime-profiles.json`; deployment targets must consume that manifest rather than copy it.

## Structure and extension

```text
config/                  # package-owned schema and defaults
src/
├── spec.ts, config.ts, types.ts
├── machine.ts           # cloneable machine contract and routing
├── local.ts, docker.ts, platform.ts # provider adapters
└── index.ts             # package facade
```

- Preserve the shallow provider layout while each adapter is cohesive. Give a provider a subdirectory only when it gains multiple private modules or an independently evolving policy and test seam.
- Adding a provider requires schema and default updates, narrow credential inputs, an adapter, explicit router selection, exports, and contract tests in the same change.
- Never add an implicit provider fallback or move host orchestration into this package.

## Change boundaries

- Change sandbox schemas, package-local configuration, parser tests, and adapter contract tests together.
- Depend only on sandbox-owned narrow option types; do not import an aggregate application config.
- Do not grant Docker socket access or broaden local environment forwarding.

## Validation

- Run `npm test --prefix packages/sandbox` and `npm run typecheck --prefix packages/sandbox`.
- Confirm `git diff --check` and inspect configuration for credentials and mutable image references.

## Handoff

- State which provider or specification contract changed and list the package-local checks that ran.
