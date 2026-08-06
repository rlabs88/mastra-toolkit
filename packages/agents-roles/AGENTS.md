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

- Keep Cortex, Flux, and Zen together behind the canonical role and prompt contracts.
- Consume role-independent tools from `@rlabs/agent-tools` and model profiles from `@rlabs/runtime-config`.
- Preserve public role IDs and the exact six-section prompt order.
- Do not import Factory, MCode, GitHub, storage, scheduler, project-binding, credential, or API-client packages. Agent definitions may receive host-neutral tools, but never the clients or authority behind them.
- Treat request workspace and tool availability as injected capability ceilings. Prompts and model-authored identifiers cannot select another project, repository, or API authority.

## Structure and extension

```text
src/
├── roles.ts    # role IDs, metadata, and model policy
├── prompts.ts  # shared and role prompts plus six-section composition
├── agents.ts   # host-neutral Mastra agent construction
└── index.ts    # the only public TypeScript facade
```

- Add a role only when it is a durable, canonical role shared across hosts. Update its role policy, prompt, registry, agent wiring, tests, and downstream projections in the same change.
- Keep the three roles together because their schema and public registry change as one contract. Keep prompts with their composition contract so text cannot drift from the six-section order.
- Do not add TypeScript subpath exports or one-file role directories. Extract a fifth source module only after a responsibility gains an independent lifecycle or test seam.
- Keep `agents.ts` host-neutral. Host-named request-context switches, controller lifecycle, and host-specific delegation policy belong downstream behind neutral capability contracts.

## Change boundaries

- Change role behavior only with a failing package-local contract test first.
- Change prompt text, prompt composition, and prompt tests together.
- Keep Mastra Code modes, AgentController subagent projections, and Factory adapter behavior outside this package.

## Validation

- Run `npm run check` from this package.
- Run `git diff --check` from the repository root and inspect this package's final diff for copied prompt drift, secret values, and unrelated edits.

## Handoff

- Report which canonical role contract changed, which tool and model package surfaces it consumes, and exact package-local checks run.
