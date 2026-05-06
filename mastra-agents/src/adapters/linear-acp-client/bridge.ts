import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { LinearAcpClientConfig } from "./config.js";
import {
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
  normalizeAcpSessionUpdate,
} from "./events.js";
import { renderLinearAcpClientEvent } from "./linear-renderer.js";
import { createInitialBinding } from "./state.js";
import type {
  LinearAcpRuntimeClient,
  LinearAcpClientAgentSessionWebhook,
  LinearAgentSessionClient,
  LinearAcpClientRuntimeEvent,
  LinearAcpClientSessionBinding,
  LinearAcpClientStateStore,
} from "./types.js";

type Logger = {
  info?: (message: string, args?: unknown) => void;
  warn?: (message: string, args?: unknown) => void;
  error?: (message: string, args?: unknown) => void;
};

export class LinearAcpClientBridge {
  constructor(private readonly deps: {
    state: LinearAcpClientStateStore;
    linear: LinearAgentSessionClient;
    acp: LinearAcpRuntimeClient;
    config: Pick<LinearAcpClientConfig, "externalUrls" | "linearCreateAsUser">;
    logger?: Logger;
  }) {}

  async handleAgentSessionEvent(payload: LinearAcpClientAgentSessionWebhook): Promise<{ accepted: boolean; reason?: string }> {
    if (!isSupportedAgentSessionEvent(payload)) {
      return { accepted: false, reason: "unsupported_event" };
    }

    const linearAgentSessionId = payload.agentSession.id;
    const webhookId = payload.webhookId ?? `${linearAgentSessionId}:${payload.action}:${payload.webhookTimestamp ?? Date.now()}`;
    if (await this.deps.state.hasProcessedWebhook(webhookId)) {
      return { accepted: true, reason: "duplicate_webhook" };
    }

    const existingBinding = await this.deps.state.getSession(linearAgentSessionId);
    let binding: LinearAcpClientSessionBinding = existingBinding ?? createInitialBinding({
      linearAgentSessionId,
      linearIssueId: optionalString(payload.agentSession.issueId),
      linearRootCommentId: optionalString(payload.agentSession.commentId),
      linearSourceCommentId: optionalString(payload.agentSession.sourceCommentId),
      linearSessionUrl: optionalString(payload.agentSession.url),
    });
    await this.deps.state.saveSession(binding);
    await this.deps.state.markWebhookProcessed(webhookId, linearAgentSessionId);

    const prompt = promptFromPayload(payload);
    if (!prompt) return { accepted: false, reason: "empty_prompt" };

    const turnId = `turn:${webhookId}`;
    let sequence = 0;
    let started = false;

    try {
      const result = await this.deps.acp.runPrompt({
        linearAgentSessionId,
        acpSessionId: binding.acpSessionId,
        prompt,
        onSessionId: async (acpSessionId) => {
          binding = { ...binding, acpSessionId };
          await this.deps.state.saveSession(binding);
          if (!started) {
            started = true;
            binding = await this.renderAndSave(binding, createTurnStartedEvent({
              linearAgentSessionId,
              acpSessionId,
              turnId,
              prompt,
            }));
          }
        },
        onUpdate: async (notification: SessionNotification) => {
          const acpSessionId = binding.acpSessionId ?? notification.sessionId;
          binding = { ...binding, acpSessionId };
          sequence += 1;
          for (const event of normalizeAcpSessionUpdate({
            linearAgentSessionId,
            acpSessionId,
            turnId,
            notification,
            sequence,
          })) {
            binding = await this.renderAndSave(binding, event);
          }
        },
      });

      binding = { ...binding, acpSessionId: result.acpSessionId };
      binding = await this.renderAndSave(binding, createTurnCompletedEvent({
        linearAgentSessionId,
        acpSessionId: result.acpSessionId,
        turnId,
        stopReason: result.stopReason,
        responseText: binding.responseTextByTurn[turnId] ?? "",
      }));
      return { accepted: true };
    } catch (error) {
      this.deps.logger?.error?.("[linear-acp-client] prompt failed", {
        linearAgentSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      const acpSessionId = binding.acpSessionId ?? "unavailable";
      binding = await this.renderAndSave(binding, createTurnFailedEvent({
        linearAgentSessionId,
        acpSessionId,
        turnId,
        error,
        responseText: binding.responseTextByTurn[turnId] ?? "",
      }));
      return { accepted: false, reason: "prompt_failed" };
    }
  }

  private async renderAndSave(binding: LinearAcpClientSessionBinding, event: LinearAcpClientRuntimeEvent): Promise<LinearAcpClientSessionBinding> {
    const next = await renderLinearAcpClientEvent({
      binding,
      event,
      linear: this.deps.linear,
      config: this.deps.config,
    });
    await this.deps.state.saveSession(next);
    return next;
  }
}

function isSupportedAgentSessionEvent(payload: LinearAcpClientAgentSessionWebhook): boolean {
  return Boolean(
    payload?.agentSession?.id &&
      (payload.action === "created" || payload.action === "prompted"),
  );
}

function promptFromPayload(payload: LinearAcpClientAgentSessionWebhook): string {
  if (payload.action === "created" && typeof payload.promptContext === "string") {
    return payload.promptContext.trim();
  }

  const content = payload.agentActivity?.content;
  if (typeof content === "string") return content.trim();
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    for (const key of ["body", "text", "prompt", "message"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    }
    return JSON.stringify(record);
  }

  return "";
}

function optionalString(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
