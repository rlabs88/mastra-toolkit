# Issue #17: Git-Based Snapshot Observability - Implementation Plan

## Status
**PLANNED** - Ready for implementation

## Goal
Replace JSONL-based snapshots with git-based snapshots (adapted from `just-claude/snapshots`) for proper tree-based diffing, content deduplication, and efficient turn/session queries.

---

## Phase 1: Core Snapshot Module

### 1.1 Create Git Snapshot Module
**File:** `mastra-agents/src/tools/git-snapshots.ts`

Adapt from `~/just-claude/hooks/snapshot/capture.ts`:
- `ensureRepo(sessionId)` - Initialize bare git repo
- `captureTurn(sessionId, paths[])` - Create turn commit from touched paths
- `captureBaseline(sessionId, source)` - Create baseline commit
- `buildCommitFromPaths(repoPath, absPaths, message, parent)`

### 1.2 Create Path Tracking Module
**File:** `mastra-agents/src/tools/git-snapshots-paths.ts`

Adapt from `~/just-claude/hooks/snapshot/touched.ts`:
- `recordTouchedPath(sessionId, absPath)` - Append to pending.paths
- `readPendingPaths(sessionId)` - Read and dedupe paths
- `clearPendingPaths(sessionId)` - Clear after capture

### 1.3 Create Git Operations Module
**File:** `mastra-agents/src/tools/git-ops.ts`

Adapt from `~/just-claude/hooks/snapshot/git-ops.ts`:
- `gitAvailable()` - Check git on PATH
- `git(args[], opts)` - Run git commands

### 1.4 Create Path Configuration
**File:** `mastra-agents/src/tools/git-snapshots-paths.ts`

Adapt from `~/just-claude/hooks/snapshot/paths.ts`:
- `snapshotRootDir()` - `~/.agents/snapshots/mastra-agents/`
- `sessionDir(sessionId)` - Per-session directory
- `snapshotRepoPath(sessionId)` - Bare repo path
- `pendingPathsFile(sessionId)` - Pending paths file

---

## Phase 2: Workspace Tool Integration

### 2.1 Integrate with Workspace Tools
**File:** `mastra-agents/src/tools/workspace.ts`

Modify `writeFile` and `replaceInFile` tools:
```typescript
// After successful write/edit:
import { recordTouchedPath } from "./git-snapshots-paths.js";
recordTouchedPath(sessionId, absPath);
```

### 2.2 Create Snapshot Query Tool
**File:** `mastra-agents/src/tools/snapshot-queries.ts`

Adapt from `~/just-claude/micro-apps/palmer/src/snapshots.ts`:
- `turnDiff(repoPath, turnN)` - `git diff tN-1 tN`
- `sessionDiff(repoPath)` - `git diff baseline/startup refs/latest`
- `listTurns(repoPath)` - `git for-each-ref refs/turn/main/`
- `fileAtTurn(repoPath, turnN, path)` - `git show tN:path`
- `parseUnifiedDiff(diff)` - Parse diff into structured entries

### 2.3 Add Query Tool to Workspace
**File:** `mastra-agents/src/tools/workspace.ts`

Add to workspace tools:
- `read_snapshots` → calls `snapshotQueries.sessionDiff()`
- `list_turns` → calls `snapshotQueries.listTurns()`
- `turn_diff(turnN)` → calls `snapshotQueries.turnDiff(turnN)`

---

## Phase 3: Agent Lifecycle Hooks

### 3.1 Create Hook Manager
**File:** `mastra-agents/src/hooks/snapshot-hooks.ts`

Integrate with Mastra agent lifecycle:
- `onSessionStart(sessionId, cwd)` → `captureBaseline(sessionId, "startup")`
- `onStop(sessionId)` → `captureTurn(sessionId, readPendingPaths())`
- `onSessionEnd(sessionId)` → `captureBaseline(sessionId, "end")`
- `onToolUse(toolName, toolInput, cwd)` → `extractWritePath()` and `recordTouchedPath()`

### 3.2 Wire Hooks to Agent
**File:** `mastra-agents/src/agents/supervisor-agent.ts`

Add hook invocations to agent execution context.

### 3.3 Add Hooks to Developer Agent
**File:** `mastra-agents/src/agents/developer-agent.ts`

Ensure developer agent also triggers path recording.

---

## Phase 4: Session ID Management

### 4.1 Create Session Manager
**File:** `mastra-agents/src/session.ts`

- `getOrCreateSessionId()` - Get from context or generate UUID
- `getSnapshotRepoPath(sessionId)` - Return bare repo path
- `getSessionDir(sessionId)` - Return session directory

---

## Phase 5: Build & Verify

### 5.1 Build
```bash
cd mastra-agents && npm run build
```

### 5.2 Restart Server
```bash
# Kill existing mastra process
pkill -9 -f "mastra"

# Start with new snapshot integration
cd mastra-agents && MASTRA_WORKSPACE_ROOT=/home/daytona/mastra-system-issue-17-snapshot npm run dev
```

---

## Phase 6: E2E Observability Test

### 6.1 Test Script
**File:** `test-git-snapshot-e2e.mjs`

```javascript
// 1. Start session
const sessionId = crypto.randomUUID();

// 2. Capture baseline
await captureBaseline(sessionId, "startup");

// 3. Write file 1
await workspaceTools.writeFile({ path: "test-alpha.md", content: "# Alpha\n" });

// 4. Write file 2  
await workspaceTools.writeFile({ path: "test-beta.md", content: "# Beta\n" });

// 5. Stop → capture turn
await captureTurn(sessionId);

// 6. Edit file 1
await workspaceTools.replaceInFile({ 
  path: "test-alpha.md", 
  oldText: "# Alpha", 
  newText: "# Alpha\n## Revised" 
});

// 7. Stop → capture turn
await captureTurn(sessionId);

// 8. Query results
const turns = await listTurns(repoPath);
const session = await sessionDiff(repoPath);
const turn2Diff = await turnDiff(repoPath, 2);

// 9. Verify
assert(turns.length === 2, "Should have 2 turns");
assert(session.files.length > 0, "Session diff should have changes");
assert(turn2Diff.files.some(f => f.path === "test-alpha.md"), "Turn 2 diff should show alpha.md");
```

### 6.2 Run E2E Test
```bash
node test-git-snapshot-e2e.mjs
```

### 6.3 Verify Git Queries Work
```bash
# List turns
git --git-dir=~/.agents/snapshots/mastra-agents/<session>/snapshots.git/ \
  for-each-ref refs/turn/main/

# Show turn diff
git --git-dir=~/.agents/snapshots/mastra-agents/<session>/snapshots.git/ \
  diff refs/turn/main/t1 refs/turn/main/t2

# Show session diff
git --git-dir=~/.agents/snapshots/mastra-agents/<session>/snapshots.git/ \
  diff refs/baseline/startup refs/latest
```

---

## File Manifest

| File | Source | Purpose |
|------|--------|---------|
| `mastra-agents/src/tools/git-ops.ts` | `~/just-claude/hooks/snapshot/git-ops.ts` | Git CLI wrapper |
| `mastra-agents/src/tools/git-snapshots-paths.ts` | `~/just-claude/hooks/snapshot/paths.ts` | Path configuration |
| `mastra-agents/src/tools/git-snapshots.ts` | `~/just-claude/hooks/snapshot/capture.ts` | Core snapshot logic |
| `mastra-agents/src/tools/git-snapshots-touched.ts` | `~/just-claude/hooks/snapshot/touched.ts` | Path tracking |
| `mastra-agents/src/tools/snapshot-queries.ts` | `~/just-claude/micro-apps/palmer/src/snapshots.ts` | Query tools |
| `mastra-agents/src/hooks/snapshot-hooks.ts` | (new) | Lifecycle hook integration |
| `mastra-agents/src/session.ts` | (new) | Session ID management |
| `mastra-agents/src/tools/workspace.ts` | (modify) | Add path recording |
| `mastra-agents/src/agents/supervisor-agent.ts` | (modify) | Add hooks |
| `mastra-agents/src/agents/developer-agent.ts` | (modify) | Already has workspace tools |
| `mastra-agents/src/prompts/tools.ts` | (modify) | ✅ Already done |

---

## Execution Order

```
Phase 1 (Core Module)
  ├── 1.1 git-ops.ts
  ├── 1.2 git-snapshots-paths.ts
  ├── 1.3 git-snapshots.ts
  └── 1.4 git-snapshots-touched.ts

Phase 2 (Workspace Integration)
  ├── 2.1 Modify workspace.ts
  ├── 2.2 snapshot-queries.ts
  └── 2.3 Add query tools to workspace.ts

Phase 3 (Lifecycle Hooks)
  ├── 3.1 snapshot-hooks.ts
  ├── 3.2 Wire to supervisor-agent
  └── 3.3 Wire to developer-agent

Phase 4 (Session Management)
  └── 4.1 session.ts

Phase 5 (Build & Restart)
  ├── 5.1 Build
  └── 5.2 Restart

Phase 6 (E2E Test)
  ├── 6.1 Create test
  ├── 6.2 Run test
  └── 6.3 Verify git queries
```

---

## Success Criteria

- [ ] `git init --bare` creates snapshot repo on session start
- [ ] `write_file` tool records path to pending.paths
- [ ] `edit_file` tool records path to pending.paths
- [ ] `onStop` creates turn commit with touched paths
- [ ] `onSessionEnd` creates baseline/end commit
- [ ] `turnDiff(repo, N)` returns diff between tN-1 and tN
- [ ] `sessionDiff(repo)` returns diff from baseline to latest
- [ ] Git refs created: `refs/turn/main/t1`, `refs/baseline/startup`, `refs/latest`
- [ ] E2E test passes with git query verification

---

## Estimated Lines of Code

- Core modules: ~400 lines
- Integration: ~150 lines
- Tests: ~100 lines
- **Total: ~650 lines**

---

## Reference

- **just-claude/snapshots:** `~/just-claude/hooks/snapshot/`
- **Issue doc:** `.agents/plans/issue-17-git-snapshot-implementation.md`
