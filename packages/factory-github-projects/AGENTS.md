---
kind: agent-instructions
version: 1
scope: "packages/factory-github-projects/**"
status: active
inherits: ../../AGENTS.md
applies_to: ["**/*"]
---

# GitHub Projects V2 Control Plane

- Read `CONTEXT.md` before changing this package.
- Keep GitHub credentials and webhook signature verification in the consuming Factory host. This package receives a narrow GraphQL port and already-verified events.
- Use only the public governed Factory automation command port. Never construct an `AgentController`, transition service, source-control session, or sandbox.
- Treat Project fields, issue content, and webhook payloads as untrusted desired state.
- Preserve global `contentNodeId` identity and deployment-wide execution leases across every binding.
- Add a failing contract test before changing scheduling, identity, persistence, projection, or lease behavior.
