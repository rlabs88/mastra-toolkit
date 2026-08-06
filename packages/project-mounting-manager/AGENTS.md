---
kind: agent-instructions
version: 1
scope: "packages/project-mounting-manager/**"
status: active
inherits: "../../AGENTS.md"
applies_to: ["**/*"]
---

# Project Mounting Manager Agent Policy

## Read first

- Read the repository root `AGENTS.md` and `CONTEXT.md`.
- Read this folder's `CONTEXT.md` before changing its contracts.

## Operating rules

- Keep project discovery independent of Mastra Code SDK and Factory runtime types.
- Model host and MCP changes as prepared transactions with explicit commit and rollback.
- Publish workflows as agent tools only when their module exports valid `agentTool` metadata.
- Preserve the last-known-good generation whenever discovery, validation, preparation, or commit fails.
- Keep GitHub Project planning, work selection, execution leases, Factory transitions, and status projection outside this package. Project resources cannot change Factory bindings or control-plane policy.

## Structure and extension

```text
src/
├── manager.ts, generation.ts, diagnostics.ts # reload and publication lifecycle
├── specialists.ts, specialist-tool.ts         # mounted agent resources
├── workflows.ts, mcp-config.ts                 # workflow and MCP discovery
├── watcher.ts, ports.ts                        # observation and host boundaries
└── index.ts                                    # package facade
```

- `manager.ts` owns reload serialization, activation, and rollback. Extract a candidate-generation object only when it gains an independent lifecycle or a second coordinator consumes it.
- Keep host effects behind `ports.ts`. External mutations must be prepared, then committed or rolled back; publication remains explicit and last-known-good state remains available.
- Extract workflow compilation or tool publication only when it gains independent caching, sandboxing, dependency, permission, versioning, audit, or reuse policy.
- New consumers import from the package root. Existing root and subpath exports are compatibility surfaces and require an explicit migration before removal.

## Change boundaries

- Keep model resolution, MCP lifecycle, current tool discovery, and host registration behind narrow ports.
- Do not import root `src/` modules; this package must remain independently consumable.
- Do not add a second project manifest or infer workflow publication from discovery alone.

## Validation

- Run `npm test`, `npm run typecheck`, and `npm run build` from this folder.
- Confirm `git diff --check` and verify no generated `dist/` output is committed accidentally.

## Handoff

- Report transaction and rollback behavior exercised by tests.
- Name any host adapter or MCP implementation that remains the caller's responsibility.
