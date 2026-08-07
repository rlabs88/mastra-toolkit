# GitHub Projects V2 ↔ Factory operations

This runbook is the reproducible operator artifact for [Wayfinder issue #175](https://github.com/rlabs88/mastra-toolkit/issues/175). It describes the local two-factory deployment and the exact state contract implemented by PR #170. It contains stable identifiers only; credentials remain in Infisical project `0b0f6354-029f-45a7-9c1c-b65968b5f46c`, environment `dev`, path `/mastra-toolkit`.

## State and ownership

| GitHub status | Factory state | Effect |
| --- | --- | --- |
| Backlog | absent | Project planning only |
| Intake | `intake` | Prepare one governed work item; do not invoke an agent |
| Investigate | `triage` | Invoke the built-in `factory-triage` rule |
| Planning | `planning` | Enter planning |
| Building | `execute` | Enter implementation |
| Review | `review` | Enter review |
| Done | `done` | Complete |
| Canceled | `canceled` | Cancel |

GitHub Intake is the only admission boundary. Later GitHub statuses request governed Factory transitions. Factory is authoritative for the accepted operational stage and projects that stage back to GitHub. If both sides changed since the last reconciliation, Factory wins and a durable diagnostic records the conflict. Removing a Project item never deletes Factory history.

When Projects V2 is configured, the host rule set disables Factory's generic `issueOpened` and `pullRequestOpened` materialization rules. The canonical GitHub integration remains responsible for credentials, repository sessions, verified webhooks, and issue refresh events, but it cannot bypass Project Intake. Every rule-created role session resolves the bound Factory project's authoritative default model before kickoff.

## Bindings

### Alpha Factory

- Factory project ID: `81fa2b82-0707-4d74-b96d-43f9b2087a1b`
- GitHub Project #4: `PVT_kwDOEL-dWs4BfoK7`
- Repositories: `rlabs88/trading-mono`, `rlabs88/alpha`, `rlabs88/x-charts`, `rlabs88/x-data`, `rlabs88/ict`, `rlabs88/ictlib`

### Agent Factory

- Factory project ID: `c60e1a31-6e0c-43d2-81c1-2d0694ab031a`
- GitHub Project #5: `PVT_kwDOEL-dWs4BfoLB`
- Repositories: `rlabs88/agentics-mono`, `rlabs88/just-oc`, `rlabs88/opencode`, `rlabs88/mastra`, `rlabs88/mastra-code`, `rlabs88/mastra-toolkit`, `rlabs88/skills`, `rlabs88/linear-toolkit`, `rlabs88/homelab-mono`

The local `homelab-toolkit` checkout resolves to the canonical GitHub repository `rlabs88/homelab-mono`. Repository membership is an explicit Factory-project allowlist; naming similarity grants no authority.

## Local lifecycle

Run the Factory with secrets injected at process startup:

```bash
npm run dev:factory:infisical
```

The configured GitHub App supplies credentials, repository installation state, HMAC verification, and webhook ingress. The Projects integration subscribes as a verified-webhook observer and also polls so missed deliveries converge. Do not place tokens or webhook secrets in `GITHUB_PROJECTS_CONFIG`.

The local database lives under `~/.mastra-toolkit/factory/`. Before a destructive migration, stop Factory and move the whole directory to a timestamped backup. Seed projects and repository links through Factory's public storage domains, then update the stable binding configuration in Infisical. Never edit Factory tables directly.

Rollback is: stop Factory, archive the new directory, restore the timestamped directory, restore the matching Infisical binding IDs, and restart. Preserve both database backups until the end-to-end audit is accepted.

## Public webhook proof

Build the credential-free Cloudflare Quick Tunnel target documented in [`deployment/factory-webhook-ingress`](../deployment/factory-webhook-ingress/README.md). It forwards to the existing signature-verifying `/web/github/webhook` route and is for temporary tests only. Polling remains the recovery path. The central A1 listener and `webbs.renaissancelab.org` remain owned by `homelab-mono`; this change does not deploy or mutate that runtime.

For a proof, require all of the following:

1. An unsigned public delivery returns 401.
2. A correctly HMAC-signed `projects_v2` or `projects_v2_item` delivery returns 202 and creates a durable reconciliation request.
3. Backlog creates no Factory work item.
4. Intake creates exactly one revision-1 card and no deferred decision or agent message.
5. Investigate creates an `intake → triage` history entry attributed to `integration:github-projects-v2` and exactly one `factory-triage` decision.
6. A Factory-originated stage change is projected to the corresponding GitHub status.

Stop the tunnel after the proof and restore any changed GitHub App callback URL. A Quick Tunnel URL is ephemeral and must not be recorded as deployment configuration.
