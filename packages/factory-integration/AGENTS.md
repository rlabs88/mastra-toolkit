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

- Own Factory authentication, storage, integrations, project execution context, and sandbox provisioning here.
- Consume canonical roles directly from `agents-roles` and sandbox machines from `sandbox`.
- Depend on `mcode` only through a narrow export when Factory concretely hosts Code sessions or provider state.
- Keep the executable Factory composition in `apps/factory` and deployment artifacts outside packages.

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
