# Mastra System

A monorepo for the Mastra agentic development environment, organized as a multi-package workspace.

```
mastra-system/
├── mastra-code/       @mastrasystem/code — Mastra Code wrapper (CLI + TUI)
├── mastra-agents/     @mastrasystem/agents — Supervisor + specialist agent patterns
│   └── paseo/         @mastrasystem/paseo — Relay network adapter
├── package.json       Workspace root (npm/bun workspaces)
└── tsconfig.base.json Shared TypeScript config
```

## Packages

### `@mastrasystem/code` — Mastra Code Wrapper

Thin local wrapper around `mastracode` using the public Mastra Code API:

- `createMastraCode(...)` for harness setup
- `MastraTUI` for the terminal UI
- `Agent` definitions for custom modes
- `subagents` definitions for focused child agents
- `initialState` for documented startup defaults

```bash
cd mastra-code
bun install
bun run mastra-code -- --cwd /path/to/project
```

### `@mastrasystem/agents` — Agent Patterns

Supervisor + 6 specialist agents in the Daytona agents pattern (Eugenechan00/daytona-agents):

| Agent | Role |
|---|---|
| `supervisor` | Orchestrator — delegates to specialists |
| `scout` | Current-state discovery |
| `researcher` | External documentation and ecosystem research |
| `architect` | Boundary, contract, and integration design |
| `advisor` | Critique of plans, risks, and tradeoffs |
| `developer` | Focused implementation |
| `validator` | Diff, test, and evidence validation |
| `control` | Evaluative quality control |

**Tools:** Daytona sandbox (create/list/execute), workspace filesystem  
**Scorers:** Prompt alignment, answer relevancy, toxicity  
**Storage:** PostgresStore + DuckDBStore + FilesystemStore (composite)  
**Sandbox:** Auto current-sandbox LocalSandbox when already inside Daytona; DaytonaAgentsDaytonaSandbox for forced/remote Daytona workspaces

See [Mastra agent calling methods](docs/mastra-agent-calling-methods.md) for the Pi `agent_query` surface, default `resourceId`/`threadId` behavior, and how to start a new conversation thread intentionally.

See [Mastra multi-channel architecture plan](docs/mastra-multichannel-architecture-plan.md) for the shared parent-scope implementation plan spanning Slack, GitHub, and Linear channels.

See [daytona-agents](https://github.com/Eugenechan00/daytona-agents) for the reference implementation.

### `@mastrasystem/paseo` — Paseo Adapter

Custom relay network adapter for the Mastra system.

## Setup

### 1. Install dependencies

```bash
bun install  # or npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your API keys and preferences
```

### 3. Workspace sandbox (optional, for @mastrasystem/agents)

When running inside an existing Daytona sandbox (`DAYTONA_SANDBOX_ID` is present), the Mastra workspace defaults to the current sandbox so agents can see `/home`, `/workspace`, and `/shared` volume mounts. Set `MASTRA_WORKSPACE_SANDBOX=daytona` plus `DAYTONA_API_KEY`/`DAYTONA_API_URL` to force a nested Daytona workspace sandbox.

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic / Claude |
| `OPENAI_API_KEY` | OpenAI |
| `MINIMAX_API_KEY` | MiniMax |
| `DAYTONA_API_KEY` | Daytona sandbox API |
| `MASTRA_DAYTONA_ENDPOINT` | Daytona server endpoint |
| `MASTRA_WORKSPACE_SANDBOX` | `auto`/empty, `local`, or `daytona` workspace command sandbox |
| `MASTRA_WORKSPACE_ACCESS_ROOTS` | Comma-separated absolute file-tool roots (defaults to `/` inside Daytona; use `/home/daytona,/shared` to narrow) |
| `MASTRA_WORKSPACE_COMMAND_CWD` | Command cwd for the local/current sandbox workspace |
| `MASTRA_CODE_MODEL` | Orchestrator model (default: rl/gpt-5.5) |
| `MASTRA_SUBAGENT_MODEL` | Subagent model (default: minimax-coding-plan/MiniMax-M2.7) |

## Type checking

```bash
bun run typecheck   # runs typecheck across all workspace packages
```
