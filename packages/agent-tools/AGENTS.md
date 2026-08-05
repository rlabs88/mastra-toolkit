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
- Keep command execution contained to the resolved workspace root and fail closed on permission, traversal, symlink, timeout, or public-network validation errors.
- Keep browser actions visible and preserve explicit approval for mutating navigation, tab, and page actions.

## Structure and extension

```text
src/
├── adhd.ts, audit.ts, browser.ts # small standalone capabilities
├── command-run/                  # one deep execution contract
│   ├── parser, scheduler, process, paths, web, media, trace, adapters
│   └── index.ts                  # Command Run facade
└── index.ts                      # package facade
```

- Treat `command-run/` as one behavioral unit; changes spanning its parser, execution, containment, media, web, and audit surfaces must remain coherent.
- Start a new role- and host-neutral tool as one module. Create a subdirectory only after it has multiple private responsibilities behind one narrow facade.
- Existing helper exports are compatibility surfaces. New internals do not become public solely for testing; add or narrow exports only through an explicit compatibility migration.

## Change boundaries

- Change behavior only with a failing package-local contract test first.
- Change parser, scheduler, adapter, trace, media, and web contracts together when a modification crosses those surfaces.
- Do not add role prompts, model routing, Code modes, subagent projections, or Factory lifecycle behavior here.

## Validation

- Run `npm run check` from this package.
- Run `git diff --check` from the repository root and inspect this package's final diff for secret values and unrelated edits.

## Handoff

- Report which tool contract changed, the approval or containment impact, and exact package-local checks run.
