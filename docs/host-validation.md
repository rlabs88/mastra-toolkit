# Host validation

Host-affecting changes require executable evidence from the real MCode, Studio, and Factory compositions. Unit tests remain necessary but do not prove that the TUI, browser UI, storage, background workers, and shutdown lifecycle compose correctly.

## Preconditions

Run typecheck, focused tests, and build first. Confirm `agent-browser` and its Chrome engine are installed, a CUA/computer-use capability is available, and Infisical access works without printing resolved values. Use temporary host-data directories rather than a developer's live databases. An unavailable CUA or credential gate is reported as blocked validation, not as a pass.

## MCode

Run `npm run code:infisical` in a private interactive tmux session. Wait up to 120 seconds for the TUI, capture the initial pane and a CUA screenshot, submit a deterministic request for `MCODE_E2E_OK`, and require the response within 180 seconds. Run one read-only `command_run` operation and verify its workspace is the isolated checkout. Exercise one rendered mode or agent switch, exit normally, require exit within 30 seconds, verify the MCode database, and confirm no owned child process remains. When CUA is unavailable, repeat with literal tmux keystrokes and record the CUA gate as blocked.

## Factory

Run `npm run dev:factory:infisical` as a named persistent tmux job and discover its URL from logs. Open the URL in a dedicated headed `agent-browser` session, capture an accessibility snapshot and screenshot, and verify there are no fatal page or console errors. Create or open an isolated Factory project/session, request `FACTORY_E2E_OK`, verify exactly one response and the expected project/repository binding, refresh to prove persistence, then repeat the critical path with visual CUA mouse/keyboard interaction. Send `SIGTERM`, require shutdown within 30 seconds, verify the port closes, and confirm no Factory worker remains.

## Studio

When MCode/Studio composition changes, run `npm run dev:infisical`, discover the URL, and use an isolated browser session to select a canonical agent, create a session, request `STUDIO_E2E_OK`, reload to prove Studio-specific persistence, and inspect console/network errors. Repeat the critical visual path with CUA when presentation changed, then verify graceful shutdown.

## Evidence

Store pane/server logs, accessibility snapshots, console and network reports, screenshots, exit codes, and storage-path listings in a temporary directory outside tracked source. Scrub credentials before handoff. A host passes only when it reaches ready state, completes the deterministic request in the authorized workspace, persists to the expected host store, shuts down within 30 seconds, and leaves no owned listener, worker, browser, or child process.
