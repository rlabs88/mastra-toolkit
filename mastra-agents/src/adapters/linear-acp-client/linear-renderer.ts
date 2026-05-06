import type { LinearAcpClientConfig } from "./config.js";
import type { LinearAgentSessionClient, LinearAcpClientRuntimeEvent, LinearAcpClientSessionBinding } from "./types.js";

export async function renderLinearAcpClientEvent(params: {
  binding: LinearAcpClientSessionBinding;
  event: LinearAcpClientRuntimeEvent;
  linear: LinearAgentSessionClient;
  config: Pick<LinearAcpClientConfig, "externalUrls" | "linearCreateAsUser">;
}): Promise<LinearAcpClientSessionBinding> {
  const { event, linear, config } = params;
  const binding = applyEventToBinding(params.binding, event);

  if (binding.emittedEventIds.includes(event.id)) return binding;

  if (event.type === "turn.started" && config.externalUrls.length > 0 && !binding.attachedExternalUrls) {
    await linear.updateAgentSession(binding.linearAgentSessionId, {
      addedExternalUrls: config.externalUrls,
    });
    binding.attachedExternalUrls = true;
  }

  if (event.type.startsWith("tool.")) {
    await linear.createAgentActivity({
      agentSessionId: binding.linearAgentSessionId,
      content: actionContent(event),
    });
  }

  if (event.type === "agent.thought.delta") {
    const text = stringField(event.payload.text);
    if (text) {
      await linear.createAgentActivity({
        agentSessionId: binding.linearAgentSessionId,
        content: { type: "thought", body: truncateMarkdown(text, 1800) },
        ephemeral: true,
      });
    }
  }

  if (event.type === "turn.completed") {
    const body = binding.responseTextByTurn[event.turnId] || stringField(event.payload.responseText) || "";
    if (body.trim()) {
      await linear.createAgentActivity({
        agentSessionId: binding.linearAgentSessionId,
        content: { type: "response", body },
      });
    }
  }

  if (event.type === "turn.failed") {
    await linear.createAgentActivity({
      agentSessionId: binding.linearAgentSessionId,
      content: { type: "error", body: `linear-acp-client turn failed: ${stringField(event.payload.error) ?? "Unknown error"}` },
    });
  }

  await upsertObservabilityComment({ binding, event, linear, createAsUser: config.linearCreateAsUser });
  binding.emittedEventIds.push(event.id);
  return binding;
}

export function applyEventToBinding(binding: LinearAcpClientSessionBinding, event: LinearAcpClientRuntimeEvent): LinearAcpClientSessionBinding {
  if (event.type === "agent.response.delta") {
    const text = stringField(event.payload.text);
    if (text) {
      binding.responseTextByTurn[event.turnId] = `${binding.responseTextByTurn[event.turnId] ?? ""}${text}`;
    }
  }

  if (event.type === "agent.thought.delta") {
    const text = stringField(event.payload.text);
    if (text) {
      binding.thoughtTextByTurn[event.turnId] = `${binding.thoughtTextByTurn[event.turnId] ?? ""}${text}`;
    }
  }

  if (event.type.startsWith("tool.")) {
    const toolCallId = stringField(event.payload.toolCallId);
    if (toolCallId) {
      binding.toolSnapshots[toolCallId] = {
        toolCallId,
        title: stringField(event.payload.title) ?? binding.toolSnapshots[toolCallId]?.title ?? "tool",
        status: toolStatus(event.payload.status),
        rawInput: event.payload.rawInput ?? binding.toolSnapshots[toolCallId]?.rawInput,
        rawOutput: event.payload.rawOutput ?? binding.toolSnapshots[toolCallId]?.rawOutput,
        updatedAt: event.createdAt,
      };
    }
  }

  return binding;
}

function actionContent(event: LinearAcpClientRuntimeEvent) {
  const status = toolStatus(event.payload.status);
  return {
    type: "action",
    action: `${stringField(event.payload.title) ?? "tool"} (${status})`,
    parameter: stringifyForMarkdown(event.payload.rawInput),
    result: stringifyForMarkdown(event.payload.rawOutput ?? event.payload.content ?? ""),
  };
}

async function upsertObservabilityComment(params: {
  binding: LinearAcpClientSessionBinding;
  event: LinearAcpClientRuntimeEvent;
  linear: LinearAgentSessionClient;
  createAsUser?: string;
}) {
  const { binding, linear, createAsUser } = params;
  if (!binding.linearIssueId) return;
  const body = observabilityCommentBody(binding);

  if (binding.observabilityCommentId) {
    await linear.updateComment(binding.observabilityCommentId, { body });
    return;
  }

  const result = await linear.createComment({
    issueId: binding.linearIssueId,
    body,
    ...(createAsUser ? { createAsUser } : {}),
  });
  const id = resultId(result, "comment");
  if (id) binding.observabilityCommentId = id;
}

export function observabilityCommentBody(binding: LinearAcpClientSessionBinding): string {
  const turns = Object.entries(binding.responseTextByTurn);
  const tools = Object.values(binding.toolSnapshots);
  const lines = [
    "## linear-acp-client observability",
    "",
    `- Linear Agent Session: ${binding.linearAgentSessionId}`,
    `- ACP Session: ${binding.acpSessionId ?? "pending"}`,
    binding.linearSessionUrl ? `- Linear Session URL: ${binding.linearSessionUrl}` : undefined,
    "",
    "### Tool calls",
    "",
    tools.length === 0 ? "_No tool calls observed yet._" : tools.map((tool) => [
      `#### ${tool.title}`,
      "",
      `- ID: ${tool.toolCallId}`,
      `- Status: ${tool.status}`,
      "",
      "**Input**",
      "",
      fencedJson(tool.rawInput),
      "",
      "**Output**",
      "",
      fencedJson(tool.rawOutput),
    ].join("\n")).join("\n\n"),
    "",
    "### Agent responses",
    "",
    turns.length === 0 ? "_No agent response observed yet._" : turns.map(([turnId, text]) => [
      `#### ${turnId}`,
      "",
      truncateMarkdown(text, 6000),
    ].join("\n")).join("\n\n"),
  ].filter((line): line is string => typeof line === "string");

  return lines.join("\n");
}

function resultId(result: unknown, key: "comment" | "agentActivity"): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  const nested = record[key];
  if (nested && typeof nested === "object" && typeof (nested as { id?: unknown }).id === "string") {
    return (nested as { id: string }).id;
  }
  return undefined;
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${stringifyForMarkdown(value)}\n\`\`\``;
}

function stringifyForMarkdown(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return truncateMarkdown(value, 4000);
  try {
    return truncateMarkdown(JSON.stringify(value, null, 2), 4000);
  } catch {
    return truncateMarkdown(String(value), 4000);
  }
}

function truncateMarkdown(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 24)}\n\n...[truncated]`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toolStatus(value: unknown): "pending" | "in_progress" | "completed" | "failed" {
  if (value === "pending" || value === "in_progress" || value === "completed" || value === "failed") return value;
  return "pending";
}
