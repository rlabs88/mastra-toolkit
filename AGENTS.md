# Agent Prompt Rewrite Notes

- The Scout rewrite should use Claude subagent references and Claude Code system prompt references as evidence for role depth, tool discipline, and output contracts.
- Use the DeepWiki tool to query codebase repository knowledge when validating upstream Mastra behavior, workspace tooling, or external repository patterns.
- Do not use Mastra Code or `references/mastra/mastracode` as a reference source for this rewrite. Mastra Code is out of scope for the Scout prompt rewrite and should be treated as irrelevant unless the user explicitly reintroduces it.

## Agent Docs Index

- `.agents/docs/workspace-runtime.md` records the workspace runtime configuration for agent tarball packaging: home, `/container`, and `/shared` file access; built-in `execute_command`; and project plus home skill imports.
- ACP source lives in `mastra-agents/acp`; compiled runtime output belongs in ignored `compiled/mastra-agents/acp`, not `mastra-agents/src/acp`.
