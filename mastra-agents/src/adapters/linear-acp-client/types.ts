import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";

export type LinearAcpClientRuntimeEventType =
  | "session.started"
  | "turn.started"
  | "agent.response.delta"
  | "agent.response.completed"
  | "agent.thought.delta"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "tool.failed"
  | "plan.updated"
  | "usage.updated"
  | "turn.completed"
  | "turn.failed";

export interface LinearAcpClientRuntimeEvent {
  id: string;
  type: LinearAcpClientRuntimeEventType;
  linearAgentSessionId: string;
  acpSessionId: string;
  turnId: string;
  createdAt: string;
  acp?: {
    sessionUpdate?: SessionUpdate["sessionUpdate"];
    notification?: SessionNotification;
  };
  payload: Record<string, unknown>;
}

export interface LinearAcpClientSessionBinding {
  linearAgentSessionId: string;
  linearOrganizationId?: string;
  linearIssueId?: string;
  linearRootCommentId?: string;
  linearSourceCommentId?: string;
  linearSessionUrl?: string;
  acpSessionId?: string;
  acpThreadId?: string;
  acpResourceId?: string;
  observabilityCommentId?: string;
  attachedExternalUrls?: boolean;
  processedWebhookIds: string[];
  emittedEventIds: string[];
  responseTextByTurn: Record<string, string>;
  thoughtTextByTurn: Record<string, string>;
  toolSnapshots: Record<string, LinearAcpClientToolSnapshot>;
  createdAt: string;
  updatedAt: string;
}

export interface LinearAcpClientToolSnapshot {
  toolCallId: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  updatedAt: string;
}

export interface LinearAcpClientAgentSessionWebhook {
  action: string;
  type?: string;
  organizationId?: string;
  webhookId?: string;
  webhookTimestamp?: number;
  promptContext?: string;
  agentActivity?: {
    id?: string;
    content?: unknown;
  };
  agentSession: {
    id: string;
    organizationId?: string | null;
    issueId?: string | null;
    commentId?: string | null;
    sourceCommentId?: string | null;
    url?: string | null;
    status?: string | null;
  };
}

export interface LinearAcpClientStateStore {
  getSession(linearAgentSessionId: string): Promise<LinearAcpClientSessionBinding | undefined>;
  saveSession(binding: LinearAcpClientSessionBinding): Promise<void>;
  hasProcessedWebhook(webhookId: string): Promise<boolean>;
  markWebhookProcessed(webhookId: string, linearAgentSessionId: string): Promise<void>;
}

export interface LinearAgentSessionClient {
  createAgentActivity(input: {
    organizationId?: string;
    agentSessionId: string;
    content: Record<string, unknown>;
    ephemeral?: boolean;
    signal?: string;
  }): Promise<{ id?: string } | unknown>;
  updateAgentSession(id: string, input: Record<string, unknown> & { organizationId?: string }): Promise<unknown>;
  createComment(input: { organizationId?: string; issueId: string; body: string; createAsUser?: string }): Promise<{ id?: string } | unknown>;
  updateComment(id: string, input: { organizationId?: string; body: string }): Promise<unknown>;
}

export interface LinearAcpRuntimeClient {
  runPrompt(params: {
    linearAgentSessionId: string;
    acpSessionId?: string;
    prompt: string;
    onSessionId: (acpSessionId: string) => Promise<void> | void;
    onUpdate: (notification: SessionNotification) => Promise<void> | void;
  }): Promise<{ acpSessionId: string; stopReason?: string }>;
  cancel?(linearAgentSessionId: string): Promise<void>;
  close?(linearAgentSessionId: string): Promise<void>;
}
