---
domain: test-engineering
wiki: procedure
status: active
aliases:
  - end user acceptance test
  - acceptance test before merge
---

# End-user acceptance test before a merge

A green suite proves the code compiles and its units behave. It does not prove a person can start
the product and get an answer. Both hosts in this repository have shipped a passing suite while
being unusable at the front door — a tool whose schema no provider would accept, a specialist file
that killed the runtime at mount, a session whose model resolved to nothing. Every one of those
passed `npm test`.

An agent must run this acceptance test and record its result before filing a pull request for
merge. #requirement/testing/critical

A passing unit suite does not satisfy this requirement and never substitutes for it.
#non-goal/testing/excluded

> This note is a wiki object of type `procedure`. It states the steps and the evidence each step
> must produce. What the model-selection path *is* belongs to
> [agent harness model selection](agent-harness-model-selection.md).

## Scope

Run the host that the change can reach. A change to shared packages reaches both.

| Change touches | MCode leg | Factory leg |
| --- | --- | --- |
| `packages/mcode/**`, `apps/mcode/**` | required | skip |
| `packages/factory-*/**`, `apps/factory/**` | skip | required |
| `packages/agent-tools`, `agents-roles`, `runtime-config`, `mastra-primitives-export`, `project-mounting-manager`, `sandbox` | required | required |

## Test model

Run the acceptance test on `code-economic`, then restore `code-frontier-high` as the default before
finishing. #requirement/testing/high

The test proves the harness boots, dispatches, and renders. It does not measure answer quality, so
the cheapest model that can hold a turn is the correct instrument. Restoring the default is part of
the procedure, not cleanup after it: a run that leaves the cheap model in place has changed the
product while testing it. #decision/testing/structural

Record the restore in the report, with the file or setting you changed back.
#validation/testing/inspection

## MCode leg

Boot MCode in a real PTY through the computer-use (CUA) tool, not through a pipe or a captured
subprocess. #requirement/testing/critical

A TUI only exercises its render path when it owns a terminal. Piping its output tests a code path no
user runs, and the failure this catches — a runtime that mounts but never draws — is invisible to
any harness that does not watch a real screen. #decision/testing/foundational

`ax mcode` is the command under test. #constraint/tooling/hard

Do not substitute `npm run code`, `node apps/mcode/bin/mcode.mjs`, or a direct `mcode`. Each skips
launcher behaviour that has already broken in production: credential wrapping, binary resolution,
and the environment `ax` builds. Testing the inner command proves nothing about the one a person
types. #decision/testing/foundational

Refresh the local `ax mcode` installation from the branch under test before launching the PTY.
#requirement/testing/critical

Record the resolved executable path and its source commit. The evidence must prove that `ax mcode`
resolves to the refreshed executable built from the source commit under test. A successful run of a
stale local installation is not evidence for the proposed change. #validation/testing/inspection

Steps:

1. Refresh the local installation, then verify the executable path and source commit.
2. Open a terminal through CUA and run `ax mcode` in the repository under test.
3. Wait for the TUI to draw. The status line, the mode indicator, and the input box must be visible.
4. Send an acceptance prompt and confirm the agent answers in the TUI.
5. Where the change engineers a specific tool or task, drive *that* capability in the same session
   rather than only exchanging a greeting.

Evidence: a screenshot or captured pane showing the rendered TUI and the agent's reply.
#validation/testing/inspection

A boot that reaches "no fatal error" but never renders is a failure, not a pass.
#requirement/testing/critical

## Factory leg

Boot the Factory and drive it through the browser GUI. #requirement/testing/critical

Run both the **Alpha Factory** and the **Agent Factory**. #requirement/testing/critical

Each Factory instance must pass both a user-created session and a ticket session.
#requirement/testing/high

These deployments exercise the same Factory runtime through different persisted projects, model
settings, repositories, and session histories. Passing one does not establish that the other can
create a sandbox, route its configured model, or resume an existing session.
#decision/testing/structural

Steps:

1. Start the Alpha Factory and Agent Factory, then open each in a browser.
2. In the Alpha Factory, send an acceptance prompt in a **user-created session** and confirm the
   agent answers.
3. In the Alpha Factory, send an acceptance prompt in a **ticket session** — one bound to an issue
   or pull request — and confirm the agent answers.
4. Repeat the user-created and ticket-session checks in the Agent Factory.

Both session kinds are required. #requirement/testing/high

They are not the same path: a ticket session carries bound work context and a different model
projection, and has failed while a user session succeeded. Testing one and inferring the other is
how a broken review surface ships. #decision/testing/structural

Evidence: for each session, a screenshot showing the prompt and the agent's reply, plus the server
log free of errors for that exchange. #validation/testing/inspection

## Reporting

State for each leg: run or skipped with the scope reason, the command or URL used, the model, the
prompt, whether the agent answered, and the evidence. Name anything you could not verify.
#requirement/documentation/high

Report a partial pass as a partial pass. An acceptance test whose result is softened in the retelling
removes the only signal it exists to produce. #requirement/testing/critical
