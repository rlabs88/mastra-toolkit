---
kind: agent-instructions
version: 1
scope: "packages/factory-integration/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# Factory Integration Package Policy

## Read first

- Read the root `AGENTS.md` and this package's `CONTEXT.md`.
- Read every consumed package checkpoint before changing a Factory projection.

## Operating rules

- Own Factory authentication, storage, integrations, provider migration, and sandbox composition here.
- Consume canonical roles directly from `agents-roles` and sandbox machines from `sandbox`.
- Depend on `mcode` only through a narrow export when Factory concretely hosts Code sessions or provider state.
- Keep the executable Factory composition in `apps/factory` and deployment artifacts outside packages.

## Structure and extension

```text
src/
├── auth.ts, storage.ts, config.ts
├── local-provider.ts, toolkit-integration.ts
├── create.ts # Factory composition facade
└── index.ts  # package facade
```

- Preserve the flat layout while each integration concern has one implementation. Create an auth, storage, provider, or integration subdirectory only after multiple implementations or private policies must evolve behind a narrow facade.
- Keep `create.ts` as the composition facade and keep executable bootstrap in `apps/factory`.
- Do not claim or add project execution context here until a dedicated slice proves a single-project Factory runtime with lifecycle, isolation, rollback, and resume contracts. Only then may this package consume `project-mounting-manager`.
- Existing exports are compatibility surfaces; narrow them only through an explicit consumer migration.

## Change boundaries

- Do not define canonical prompts, tools, model aliases, project-resource formats, or sandbox providers here.
- Change auth, storage migration, project mapping, credential policy, and their integration tests together.
- Preserve tenant, checkout, mutable-state, and credential isolation across projects.

## Validation

- Run package tests and Factory startup, auth, storage migration, sandbox, and integration contracts.
- Run secrets checks without printing resolved values.

## Handoff

- State which Factory lifecycle changed, which package contract it consumes, and the isolation evidence.
- Report unavailable external GitHub, WorkOS, Redis, database, or Platform checks explicitly.
