---
kind: checkpoint-context
version: 1
scope: "deployment/studio-server/**"
status: active
---

# Studio Server Deployment Context

## Past

Studio could run from the repository through the Mastra CLI, but central server delivery had no distinct ownership boundary from application source or Factory configuration.

## Present

This checkpoint reserves the delivery boundary for a remotely hosted Studio server. No Docker, VM, or infrastructure implementation is included in the repository restructure.

## Future

A dedicated issue will choose the container or VM target and define networking, persistence, runtime secrets, observability, health checks, rollout, and recovery.
