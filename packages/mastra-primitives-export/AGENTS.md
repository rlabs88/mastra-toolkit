---
kind: agent-instructions
version: 1
scope: "packages/mastra-primitives-export/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# Mastra Primitives Export Policy

## Read first

- Read the repository `AGENTS.md`, `CONTEXT.md`, and this package's `CONTEXT.md`.
- Read the checkpoints for every canonical package aggregated here before changing the contract.

## Operating rules

- Aggregate canonical runtime primitives through package-root exports; never copy prompts, tools, model policy, sandbox providers, or project mounting behavior.
- Keep the contract host-neutral and secret-free. Live workspaces, sandboxes, credentials, identities, browser instances, and approval state belong only to host-owned bindings.
- Never construct, mount, retain, or mutate an AgentController.
- Keep MCode, Studio, Factory, GitHub, authentication, tenancy, persistence, and process lifecycle dependencies out of this package.

## Structure and extension

```text
src/
├── primitives.ts # runtime contract, binding, and deterministic descriptor
└── index.ts      # sole public TypeScript facade
```

- Add another module only when a concern has multiple independently evolving implementations behind a narrow public facade.
- Export TypeScript through the package root only.

## Change boundaries

- Change the contract descriptor, its digest tests, all host projections, and architecture documentation together.
- A host projection may consume this package; this package may never consume a host adapter.

## Validation

- Run this package's `npm run check`, every consuming host contract, and the root checks.
- Inspect the serialized capability descriptor for credentials and mutable host state.

## Handoff

- State which canonical primitive changed and which host projections consume it.
- Report any upstream host construction surface that remains unavailable.
