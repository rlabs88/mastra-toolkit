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
├── contract.ts    # schema, environment projection, options, runtime profiles
├── providers.ts   # Local, Docker, Platform, and runtime admission adapters
├── machine.ts     # explicit provider routing
└── index.ts       # sole TypeScript package facade
```

- Keep provider implementations behind `providers.ts` while they share the cloneable machine contract and admission lifecycle. Extract a provider only when it gains a genuinely independent policy and test seam.
- Keep all supported TypeScript consumers on the package root; package-owned JSON assets may retain explicit data subpaths.
- Adding a provider requires schema and default updates, narrow credential inputs, `providers.ts`, explicit router selection, root exports, and contract tests in the same change.
- Never add an implicit provider fallback or move host orchestration into this package.

## Change boundaries

- Change sandbox schemas, package-local configuration, command execution tests, and adapter contract tests together.
- Depend only on sandbox-owned narrow option types; do not import an aggregate application config.
- Do not grant Docker socket access or broaden local environment forwarding.

## Validation

- Run `npm test --prefix packages/sandbox` and `npm run typecheck --prefix packages/sandbox`.
- Confirm `git diff --check` and inspect configuration for credentials and mutable image references.

## Handoff

- State which provider, specification, or executable tool contract changed and list the package-local checks that ran.
