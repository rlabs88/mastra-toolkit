import test from 'node:test';
import assert from 'node:assert/strict';

import { mapMastraChunkToUpdates } from '../../../compiled/mastra-agents/acp/event-mapper.js';
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
