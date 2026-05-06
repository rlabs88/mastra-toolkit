import type { SessionNotification, SessionUpdate, ToolCallStatus } from "@agentclientprotocol/sdk";

import type { LinearAcpClientRuntimeEvent, LinearAcpClientToolSnapshot } from "./types.js";

export function normalizeAcpSessionUpdate(params: {
  linearAgentSessionId: string;
  acpSessionId: string;
  turnId: string;
  notification: SessionNotification;
  sequence: number;
}): LinearAcpClientRuntimeEvent[] {
  const update = params.notification.update;
  const createdAt = new Date().toISOString();
  const base = {
    linearAgentSessionId: params.linearAgentSessionId,
    acpSessionId: params.acpSessionId,
    turnId: params.turnId,
    createdAt,
    acp: {
      sessionUpdate: update.sessionUpdate,
      notification: params.notification,
    },
  };

  if (update.sessionUpdate === "agent_message_chunk") {
    return [{
      ...base,
      id: eventId(params, `message:${params.sequence}`),
      type: "agent.response.delta",
      payload: {
        text: contentText(update),
        messageId: update.messageId,
      },
    }];
  }

  if (update.sessionUpdate === "agent_thought_chunk") {
    return [{
      ...base,
      id: eventId(params, `thought:${params.sequence}`),
      type: "agent.thought.delta",
      payload: {
        text: contentText(update),
        messageId: update.messageId,
      },
    }];
  }

  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const status = normalizeToolStatus(update.status);
    const type =
      status === "completed" ? "tool.completed" :
      status === "failed" ? "tool.failed" :
      status === "in_progress" ? "tool.started" :
      "tool.updated";
    return [{
      ...base,
      id: eventId(params, `tool:${update.toolCallId}:${status}:${params.sequence}`),
      type,
      payload: {
        toolCallId: update.toolCallId,
        title: update.title ?? "tool",
        status,
        kind: update.kind,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        content: update.content,
        locations: update.locations,
      },
    }];
  }

  if (update.sessionUpdate === "plan") {
    return [{
      ...base,
      id: eventId(params, `plan:${params.sequence}`),
      type: "plan.updated",
      payload: { entries: update.entries },
    }];
  }

  if (update.sessionUpdate === "usage_update") {
    return [{
      ...base,
      id: eventId(params, `usage:${params.sequence}`),
      type: "usage.updated",
      payload: { used: update.used, size: update.size, cost: update.cost },
    }];
  }

  return [];
}

export function createTurnStartedEvent(params: {
  linearAgentSessionId: string;
  acpSessionId: string;
  turnId: string;
  prompt: string;
}): LinearAcpClientRuntimeEvent {
  return {
    id: `${params.linearAgentSessionId}:${params.turnId}:turn-started`,
    type: "turn.started",
    linearAgentSessionId: params.linearAgentSessionId,
    acpSessionId: params.acpSessionId,
    turnId: params.turnId,
    createdAt: new Date().toISOString(),
    payload: { prompt: params.prompt },
  };
}

export function createTurnCompletedEvent(params: {
  linearAgentSessionId: string;
  acpSessionId: string;
  turnId: string;
  stopReason?: string;
  responseText: string;
}): LinearAcpClientRuntimeEvent {
  return {
    id: `${params.linearAgentSessionId}:${params.turnId}:turn-completed`,
    type: "turn.completed",
    linearAgentSessionId: params.linearAgentSessionId,
    acpSessionId: params.acpSessionId,
    turnId: params.turnId,
    createdAt: new Date().toISOString(),
    payload: {
      stopReason: params.stopReason,
      responseText: params.responseText,
    },
  };
}

export function createTurnFailedEvent(params: {
  linearAgentSessionId: string;
  acpSessionId: string;
  turnId: string;
  error: unknown;
  responseText: string;
}): LinearAcpClientRuntimeEvent {
  return {
    id: `${params.linearAgentSessionId}:${params.turnId}:turn-failed`,
    type: "turn.failed",
    linearAgentSessionId: params.linearAgentSessionId,
    acpSessionId: params.acpSessionId,
    turnId: params.turnId,
    createdAt: new Date().toISOString(),
    payload: {
      error: errorMessage(params.error),
      responseText: params.responseText,
    },
  };
}

export function snapshotFromToolEvent(event: LinearAcpClientRuntimeEvent): LinearAcpClientToolSnapshot | undefined {
  if (!event.type.startsWith("tool.")) return undefined;
  const toolCallId = stringField(event.payload.toolCallId);
  if (!toolCallId) return undefined;
  return {
    toolCallId,
    title: stringField(event.payload.title) ?? "tool",
    status: normalizeToolStatus(event.payload.status),
    rawInput: event.payload.rawInput,
    rawOutput: event.payload.rawOutput,
    updatedAt: event.createdAt,
  };
}

function eventId(params: {
  linearAgentSessionId: string;
  acpSessionId: string;
  turnId: string;
}, suffix: string): string {
  return `${params.linearAgentSessionId}:${params.acpSessionId}:${params.turnId}:${suffix}`;
}

function contentText(update: Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }>) {
  const content = update.content;
  return content.type === "text" ? content.text : JSON.stringify(content);
}

function normalizeToolStatus(status: unknown): ToolCallStatus {
  if (status === "pending" || status === "in_progress" || status === "completed" || status === "failed") {
    return status;
  }
  return "pending";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
