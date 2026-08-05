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

## Change boundaries

- Change behavior only with a failing package-local contract test first.
- Change parser, scheduler, adapter, trace, media, and web contracts together when a modification crosses those surfaces.
- Do not add role prompts, model routing, Code modes, subagent projections, or Factory lifecycle behavior here.

## Validation

- Run `npm run check` from this package.
- Run `git diff --check` from the repository root and inspect this package's final diff for secret values and unrelated edits.

## Handoff

- Report which tool contract changed, the approval or containment impact, and exact package-local checks run.
