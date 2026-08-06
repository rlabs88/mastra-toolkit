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
- Treat tool schemas, approval decisions, scheduling, containment, cancellation, output limits, attachments, audit events, and SSRF checks as one behavioral contract.

## Operating rules

- Keep this package independent from role definitions, Mastra Code SDK projections, and Factory adapters.
- Keep Command Run parsing, scheduling, approval, traces, and output contracts host-neutral. Executable sandbox containment belongs to `packages/sandbox`.
- Keep browser actions visible and preserve explicit approval for mutating navigation, tab, and page actions.
- Keep API-interacting tools request-scoped and backed by narrow injected ports. Do not store credentials, bindings, leases, persistent workers, or external SDK clients here.
- Require authorization, explicit approval for mutation, idempotency, auditability, and bounded output at external API boundaries. Do not add a generic arbitrary HTTP or API tool.

## Structure and extension

```text
src/
├── adhd.ts, audit.ts, browser.ts # small standalone capabilities
├── command-run/                  # one deep command-language contract
│   ├── parser, scheduler, process, paths, web, media, trace, adapters
│   └── index.ts                  # Command Run facade
└── index.ts                      # package facade
```

- Treat `command-run/` and the sandbox-owned executable tool as one behavioral contract; changes spanning parser, execution, containment, media, web, and audit surfaces must remain coherent across both packages.
- Start a new role- and host-neutral tool as one module. Create a subdirectory only after it has multiple private responsibilities behind one narrow facade.
- Existing helper exports are compatibility surfaces. New internals do not become public solely for testing; add or narrow exports only through an explicit compatibility migration.
- `command_run` and `adhd_run` are retained compatibility capabilities. Do not add new consumers or expand their DSL/fan-out scope; future replacement uses native Mastra workflows, task state, subagents, and background tasks after parity is proven.

## Change boundaries

- Change behavior only with a failing package-local contract test first.
- Change parser, scheduler, adapter, trace, media, and web contracts together when a modification crosses those surfaces.
- Do not add role prompts, model routing, Code modes, subagent projections, or Factory lifecycle behavior here.

## Validation

- Run `npm run check` from this package.
- Run `git diff --check` from the repository root and inspect this package's final diff for secret values and unrelated edits.

## Handoff

- Report which tool contract changed, the approval or containment impact, and exact package-local checks run.
