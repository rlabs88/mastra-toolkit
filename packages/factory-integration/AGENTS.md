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
- Consume canonical agents directly from `agents-roles` and sandbox machines from `sandbox`. Do not import MCode settings, recipes, controller lifecycle, or project detection.
- Report unsupported upstream controller or repository-configuration surfaces explicitly; do not patch Factory, construct a second controller, or read project settings from the Factory checkout.
- Keep the executable Factory composition in `apps/factory` and deployment artifacts outside packages.
- Remain the sole Factory composition owner and the sole adapter for GitHub credentials/webhook ownership. A Projects V2 control-plane extension receives verified events and governed command ports; it does not become an agent tool or a second GitHub integration owner.

## Structure and extension

```text
src/
├── config.ts      # validated config, auth, storage, and local provider migration
├── integration.ts # canonical agent bundle, delegation, and project workflow tools
├── runtime.ts     # Factory and Mastra composition lifecycle
└── index.ts       # the only public TypeScript facade
```

- Keep configuration-backed infrastructure together while each concern has one implementation. Extract a fifth source module only after multiple implementations or a private policy must evolve behind a narrow facade.
- Keep `runtime.ts` as the composition facade and keep executable signal handling in `apps/factory`.
- Do not add TypeScript implementation subpath exports.
- Factory may consume only the sandbox workflow protocol exported by `project-mounting-manager`. Do not mount its in-process generation manager until a dedicated slice proves a single-project Factory runtime with lifecycle, isolation, rollback, and resume contracts.
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
