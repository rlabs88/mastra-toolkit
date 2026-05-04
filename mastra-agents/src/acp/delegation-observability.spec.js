import test from 'node:test';
import assert from 'node:assert/strict';

import { mapMastraChunkToUpdates } from './event-mapper.js';
import { delegationPayloadFromEvent } from '../workflows/delegation-event.js';

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
  const one = mapMastraChunkToUpdates({ type: 'delegation-event', payload: { delegatedName: 'scout-agent', phase: 'delegation_start', timestamp: '1' } })[0];
  const two = mapMastraChunkToUpdates({ type: 'delegation-event', payload: { delegatedName: 'scout-agent', phase: 'delegation_start', timestamp: '2' } })[0];
  assert.notEqual(one.toolCallId, two.toolCallId);
});
