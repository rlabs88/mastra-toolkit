# Agent Prompt Rewrite Notes

- The Scout rewrite should use Claude subagent references and Claude Code system prompt references as evidence for role depth, tool discipline, and output contracts.
- Use the DeepWiki tool to query codebase repository knowledge when validating upstream Mastra behavior, workspace tooling, or external repository patterns.
- Do not use Mastra Code or `references/mastra/mastracode` as a reference source for this rewrite. Mastra Code is out of scope for the Scout prompt rewrite and should be treated as irrelevant unless the user explicitly reintroduces it.
- Mastra Agents ACP user-global binary distribution notes live at `.agents/docs/mastra-agents-acp-tarball-install.md`. Use that doc when packaging the `mastra-acp` command as an npm tarball for install or upgrade on another machine before public/private npm publishing is appropriate.
- Palmer/Linear channel setup notes live at `.agents/docs/linear-palmer-channel.md`. Keep the Linear app lean: configure Chat SDK's Linear adapter through the Mastra `Agent.channels` field on `supervisor-agent`; do not create a separate Chat SDK app or custom OAuth subsystem.
- Before implementing infrastructure that may already exist in an upstream library, query DeepWiki for the relevant repository and feature area first. Prefer official packages/classes/adapters/state implementations from the library over custom code; document the chosen package or API when adopting it.

## Agent Docs Index

- `.agents/docs/workspace-runtime.md` records the workspace runtime configuration for agent tarball packaging: home, `/container`, and `/shared` file access; built-in `execute_command`; and project plus home skill imports.
- ACP source lives in `mastra-agents/acp`; compiled runtime output belongs in ignored `compiled/mastra-agents/acp`, not `mastra-agents/src/acp`.
