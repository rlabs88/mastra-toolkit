# @mastrasystem/pi

Pi agents — adapters, extensions, and TUI for Mastra system.

## Install

Install the Pi extension globally:

```bash
pi install npm:@mastrasystem/pi
```

The extension can then be used from any directory where Pi runs. It connects to
Mastra over HTTP, so the Mastra service must be running separately. By default it
uses `http://localhost:4111/api`; override that with `MASTRA_BASE_URL` when the
service is on another host or port:

```bash
MASTRA_BASE_URL=http://localhost:4111/api pi
```

## Package Structure

```
src/
  adapters/   — Relay network adapters for remote Mastra agents
  extensions/ — Agent extensions (Pi ↔ Mastra bridge)
  tui/        — Terminal UI for Pi agents
```

## Mastra Pi Runtime

Launch Pi with the local Mastra extension:

```bash
npm run dev --workspace @mastrasystem/pi
```

`MASTRA_BASE_URL` defaults to `http://localhost:4111/api`. Override it when needed:

```bash
MASTRA_BASE_URL=http://localhost:4111/api npm run dev --workspace @mastrasystem/pi
```

## Mastra Agent Widget Config

The extension reads optional project config from `config.yaml` in the active Pi working directory:

```yaml
mastra-agent-extension:
  maxCards: 4
  maxLines: 60
  listMaxLines: 18
  listMaxAgents: 5
  reservedRows: 10
  defaultViewMode: list
  viewModeShortcut: alt+h
  nextAgentShortcut: alt+o
  previousAgentShortcut: alt+i
  detailScrollDownShortcut: alt+j
  detailScrollUpShortcut: alt+k
  detailStreamOnlyShortcut: alt+s
  colors:
    prompt: syntaxString
    tool: syntaxString
    reasoning: muted
  debug: false
  debugPiRedraw: false
```

Defaults are `maxCards: 4`, `maxLines: 60`, `listMaxLines: 18`, `listMaxAgents: 5`, `reservedRows: 10`, and `defaultViewMode: list`. Pi's default harness reasoning-effort cycle remains on `shift+tab`; you can also bind `alt+n` to `app.thinking.cycle` in your Pi keybindings if desired. List mode renders a compact above-editor job list with three lines per visible agent and a `+N more` marker when more than `listMaxAgents` jobs are working. `viewModeShortcut` cycles list → card region → detail region. The card/detail region also renders above the editor at a fixed height while jobs are visible, bounded by `maxLines` and the current terminal viewport. `nextAgentShortcut` and `previousAgentShortcut` focus running jobs in detail mode.

Detail mode supports keyboard scrolling with `detailScrollDownShortcut` and `detailScrollUpShortcut`, and `detailStreamOnlyShortcut` hides the submitted prompt and reasoning while keeping agent output and tool events visible. Widget hotkeys are installed from the active session `config.yaml`; scroll keys are consumed only when detail mode has visible running jobs. Raw Backspace and Enter-compatible terminal bytes are not consumed for `ctrl+h` or `ctrl+j`; terminals that disambiguate control keys can still use those shortcuts, and other environments can remap them in `config.yaml`.

`colors` accepts Pi theme color keys. The defaults use `syntaxString` for submitted prompt/query detail text and `muted` for reasoning text; labels and tool names stay in normal foreground text.

### Agent TUI Rendering Model

The Mastra agent widget is intentionally bounded above the editor. `maxLines` defines the largest render region, then each view mode uses that same budget differently:

- List mode shows a compact job list, capped by `listMaxAgents`, with three streaming rows per visible agent.
- Card mode splits the fixed region across active cards so adding another job shrinks the shared slots instead of growing the terminal buffer.
- Detail mode gives the whole region to one active agent, with keyboard scrolling for historical output and stream-only mode for focused live output.

Completed or cancelled jobs are removed from the visible widget surface. That keeps stale cards from reappearing while preserving the session/job lifecycle in the Mastra side of the integration.

The rendering surface uses Pi's Markdown renderer for agent output and expanded tool result bodies. Tool names and section labels remain plain foreground text, while prompt bodies and tool argument/result details use the configured highlight color. Reasoning is muted by default because it is supporting context rather than primary output.

`debug: true` writes widget metrics to `~/.pi/agent/mastra-widget-debug.log`; `debugPiRedraw: true` also enables Pi's `~/.pi/agent/pi-debug.log` redraw reasons. Leave both disabled for normal published-package use.

Run the live Mastra smoke check:

```bash
npm run smoke:mastra --workspace @mastrasystem/pi
```

Manual TUI smoke checklist:

- `/mastra status`
- `/mastra agents`
- `/mastra agent supervisor-agent`
- `/mastra workflows`
- `/mastra workflow checkApi`
- Ask Pi to list Mastra agents, inspect `supervisor-agent`, and list Mastra workflows.
