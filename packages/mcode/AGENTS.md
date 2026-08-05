---
kind: agent-instructions
version: 1
scope: "packages/mcode/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# MCode Package Policy

## Read first

- Read the root `AGENTS.md` and this package's `CONTEXT.md`.
- Read the checkpoints for `agents-roles`, `runtime-config`, `sandbox`, and `project-mounting-manager` before changing their projections.

## Operating rules

- Own all Mastra Code SDK configuration, project detection, modes, native subagents, controller mounting, session wiring, Code-specific MCP adaptation, and reusable TUI construction here.
- Consume canonical roles, tools, model profiles, sandbox behavior, and project extensions only through package public exports.
- Use published Mastra Code extension and mount APIs. Do not patch, copy, or fork upstream implementation source.
- Keep CLI argument parsing, process lifecycle, and user-facing exit behavior in `apps/mcode`.

## Change boundaries

- Do not import `@mastra/factory` or define canonical prompts and tools here.
- Change persisted settings, provider IDs, mode/subagent projections, and their compatibility tests together.
- Preserve explicit user settings and never persist proxy credentials or raw upstream model IDs.

## Validation

- Run this package's typecheck and tests plus the local MCode runtime and TUI smoke contracts.
- Pin version-sensitive Code SDK seams with integration tests before upgrading dependencies.

## Handoff

- State which Code SDK surface changed and which canonical package contract it projects.
- Report CLI/TUI, settings, session, and project-mount evidence separately.
