---
kind: agent-instructions
version: 1
scope: "packages/agents-roles/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# Agent Roles Package Policy

## Read first

- Read the repository [AGENTS.md](../../AGENTS.md) and this package's [CONTEXT.md](CONTEXT.md).
- Treat role identity, six-section prompt composition, model policy, tool assignment, delegation, workspace selection, and agent defaults as one canonical contract.

## Operating rules

- Keep Cortex, Flux, and Zen in separate `prompt.ts`, `role.ts`, and `index.ts` module folders.
- Consume role-independent tools from `@rlabs/agent-tools` and model profiles from `@rlabs/runtime-config`.
- Preserve public role IDs and the exact six-section prompt order.

## Change boundaries

- Change role behavior only with a failing package-local contract test first.
- Change prompt text, prompt composition, and prompt tests together.
- Keep Mastra Code modes, AgentController subagent projections, and Factory adapter behavior outside this package.

## Validation

- Run `npm run check` from this package.
- Run `git diff --check` from the repository root and inspect this package's final diff for copied prompt drift, secret values, and unrelated edits.

## Handoff

- Report which canonical role contract changed, which tool and model package surfaces it consumes, and exact package-local checks run.
