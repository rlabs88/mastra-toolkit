---
kind: agent-instructions
version: 1
scope: "packages/agent-tools/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# Agent Tools Package Policy

## Read first

- Read the repository [AGENTS.md](../../AGENTS.md) and this package's [CONTEXT.md](CONTEXT.md).
- Treat approval decisions, containment, cancellation, output limits, browser policy, and audit events as one behavioral contract.

## Operating rules

- Keep this package independent from role definitions, Mastra Code SDK projections, and Factory adapters.
- Keep browser actions visible and preserve explicit approval for mutating navigation, tab, and page actions.
- Keep API-interacting tools request-scoped and backed by narrow injected ports. Do not store credentials, bindings, leases, persistent workers, or external SDK clients here.
- Require authorization, explicit approval for mutation, idempotency, auditability, and bounded output at external API boundaries. Do not add a generic arbitrary HTTP or API tool.

## Structure and extension

```text
src/
├── capabilities.ts # audit, run containment, and visible-browser policy
└── index.ts        # sole TypeScript package facade
```

- Keep all supported TypeScript consumers on the package root. Do not restore implementation subpath exports.
- Start a new role- and host-neutral capability inside `capabilities.ts` until it proves a deeper independent contract.
- Do not recreate toolkit-owned command-loop or divergent-fan-out tools. A future orchestration capability belongs in an explicitly published Mastra workflow with its own approval, state, and cancellation contract.

## Change boundaries

- Change behavior only with a failing package-local contract test first.
- Do not add role prompts, model routing, Code modes, subagent projections, or Factory lifecycle behavior here.

## Validation

- Run `npm run check` from this package.
- Run `git diff --check` from the repository root and inspect this package's final diff for secret values and unrelated edits.

## Handoff

- Report which tool contract changed, the approval or containment impact, and exact package-local checks run.
