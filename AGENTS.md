# Mastra Toolkit repository guidance

- Prefer supported Mastra agents, tools, workspaces, browser, background-task, approval, and Factory extension APIs before adding toolkit-owned infrastructure.
- Preserve the public agent IDs `cortex`, `flux`, and `zen` and the six-section prompt order.
- Keep Cortex and Flux as leaf agents. Zen and Factory may delegate; recursion must remain bounded.
- Command Run must retain its parser, scheduling, containment, timeout, cancellation, output, attachment, and SSRF contracts.
- Use Infisical project `0b0f6354-029f-45a7-9c1c-b65968b5f46c`, environment `dev`, path `/mastra-toolkit`. Never commit or log secret values.
- Add or update a failing contract test before changing production behavior.
- Local, Docker, and Platform providers must satisfy the same cloneable sandbox-machine contract and must not silently fall back.
