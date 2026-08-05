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

## Structure and extension

```text
src/
├── cortex|flux|zen/{prompt.ts,role.ts,index.ts} # canonical roles
├── prompts/                                    # shared prompt sections
├── prompt.ts                                   # six-section composition
├── role.ts                                     # shared role contract
├── factory.ts                                  # host-neutral agent construction
└── index.ts                                    # package facade
```

- Add a role only when it is a durable, canonical role shared across hosts. Add its folder, registry and factory wiring, exports, tests, and downstream projections in the same change.
- Put genuinely shared prompt sections and role contracts in the shared modules; keep role-specific identity, policy, and defaults inside the role folder.
- Keep `factory.ts` host-neutral: it constructs agents but is not Mastra Factory integration. Host-named request-context switches, controller lifecycle, and host-specific delegation policy belong downstream behind neutral capability contracts.

## Change boundaries

- Change role behavior only with a failing package-local contract test first.
- Change prompt text, prompt composition, and prompt tests together.
- Keep Mastra Code modes, AgentController subagent projections, and Factory adapter behavior outside this package.

## Validation

- Run `npm run check` from this package.
- Run `git diff --check` from the repository root and inspect this package's final diff for copied prompt drift, secret values, and unrelated edits.

## Handoff

- Report which canonical role contract changed, which tool and model package surfaces it consumes, and exact package-local checks run.
