import test from 'node:test';
import assert from 'node:assert/strict';

import { createMastraChunkMapper, mapMastraChunkToUpdates } from '../../../compiled/mastra-agents/acp/event-mapper.js';
import { createDelegationObservabilityOptions } from '../../src/agents/delegation-observability.js';
import { delegationPayloadFromEvent, subscribeDelegationEvents } from '../../src/workflows/delegation-event.js';

test('delegation payload preserves structured prompt/response/error fields', () => {
  const payload = delegationPayloadFromEvent({
    type: 'delegation_complete',
    payload: {
      delegatedName: 'Scout',
      delegatedAgentId: 'scout-agent',
      prompt: { objective: 'inspect', files: ['a.ts'] },
      response: { findings: ['ok'] },
      error: { code: 'E_TIMEOUT' },
      success: false,
    },
  });
  assert.deepEqual(payload.prompt, { objective: 'inspect', files: ['a.ts'] });
  assert.deepEqual(payload.response, { findings: ['ok'] });
  assert.deepEqual(payload.error, { code: 'E_TIMEOUT' });
});

test('delegation event mapper fallback IDs remain unique', () => {
  const one = mapMastraChunkToUpdates({ type: 'delegation-event', payload: { delegatedName: 'scout-agent', phase: 'delegation_start', timestamp: 1 } })[0];
  const two = mapMastraChunkToUpdates({ type: 'delegation-event', payload: { delegatedName: 'scout-agent', phase: 'delegation_start', timestamp: 2 } })[0];
  assert.notEqual(one.toolCallId, two.toolCallId);
});

test('ACP mapper emits initial tool_call before tool updates for agent calls', () => {
  const mapChunk = createMastraChunkMapper();
  const start = mapChunk({
    type: 'tool-call-input-streaming-start',
    payload: { toolCallId: 'call-agent-1', toolName: 'agent-scoutAgent' },
  });
  const call = mapChunk({
    type: 'tool-call',
    payload: { toolCallId: 'call-agent-1', toolName: 'agent-scoutAgent', args: { prompt: 'Inspect the ACP mapper' } },
  });
  const result = mapChunk({
    type: 'tool-result',
    payload: { toolCallId: 'call-agent-1', toolName: 'agent-scoutAgent', result: { text: 'mapMastraChunkToUpdates' } },
  });

  assert.equal(start[0].sessionUpdate, 'tool_call');
  assert.equal(start[0].kind, 'think');
  assert.equal(call[0].sessionUpdate, 'tool_call_update');
  assert.deepEqual(call[0].rawInput, { prompt: 'Inspect the ACP mapper' });
  assert.equal(call[0].content[0].content.text, 'Inspect the ACP mapper');
  assert.equal(result[0].sessionUpdate, 'tool_call_update');
  assert.equal(result[0].status, 'completed');
  assert.equal(result[0].content[0].content.text, 'mapMastraChunkToUpdates');
});

test('ACP delegation events create a visible tool call and complete it with output', () => {
  const mapChunk = createMastraChunkMapper();
  const start = mapChunk({
    type: 'delegation-event',
    payload: {
      phase: 'delegation_start',
      delegationId: 'delegation-1',
      delegatedName: 'Scout',
      prompt: { objective: 'inspect' },
    },
  });
  const complete = mapChunk({
    type: 'delegation-event',
    payload: {
      phase: 'delegation_complete',
      delegationId: 'delegation-1',
      delegatedName: 'Scout',
      response: { text: 'found evidence' },
      success: true,
    },
  });

  assert.equal(start[0].sessionUpdate, 'tool_call');
  assert.equal(start[0].toolCallId, 'delegation-1');
  assert.equal(start[0].kind, 'think');
  assert.equal(start[0].content[0].content.text, 'inspect');
  assert.equal(complete[0].sessionUpdate, 'tool_call_update');
  assert.equal(complete[0].status, 'completed');
  assert.equal(complete[0].content[0].content.text, 'found evidence');
});

test('orchestration delegation hooks emit ACP-visible start and complete payloads', () => {
  const events = [];
  const unsubscribe = subscribeDelegationEvents((payload) => events.push(payload));
  try {
    const hooks = createDelegationObservabilityOptions({
      parentAgentId: 'orchestrator-agent',
      parentAgentName: 'Orchestrator',
    });

    hooks.onDelegationStart({
      primitiveId: 'scout-agent',
      primitiveType: 'agent',
      prompt: 'Inspect this workspace',
      params: {},
      iteration: 1,
      runId: 'run-1',
      threadId: 'thread-1',
      resourceId: 'resource-1',
      parentAgentId: 'orchestrator-agent',
      parentAgentName: 'Orchestrator',
      toolCallId: 'tool-1',
      messages: [],
    });
    hooks.onDelegationComplete({
      primitiveId: 'scout-agent',
      primitiveType: 'agent',
      prompt: 'Inspect this workspace',
      result: { text: 'Found evidence' },
      duration: 42,
      success: true,
      iteration: 1,
      runId: 'run-1',
      toolCallId: 'tool-1',
      parentAgentId: 'orchestrator-agent',
      parentAgentName: 'Orchestrator',
      messages: [],
      bail: () => undefined,
    });
  } finally {
    unsubscribe();
  }

  assert.equal(events.length, 2);
  assert.equal(events[0].phase, 'delegation_start');
  assert.equal(events[0].delegatedAgentId, 'scout-agent');
  assert.equal(events[0].prompt, 'Inspect this workspace');
  assert.equal(events[1].phase, 'delegation_complete');
  assert.deepEqual(events[1].response, { text: 'Found evidence' });
  assert.equal(events[1].durationMs, 42);
  assert.equal(events[1].threadId, 'thread-1');
  assert.equal(events[1].resourceId, 'resource-1');
  assert.equal(events[1].source, 'delegation-hook');
});
