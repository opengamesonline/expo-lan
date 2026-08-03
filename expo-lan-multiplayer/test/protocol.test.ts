import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_FRAME_BYTES, MessageDecoder, PROTOCOL_VERSION, encodeMessage } from '../src/protocol';

test('decodes a message split across TCP reads', () => {
  const encoded = encodeMessage({ v: PROTOCOL_VERSION, kind: 'leave' });
  const decoder = new MessageDecoder();
  assert.deepEqual(decoder.push(encoded.slice(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.slice(3)), [{ v: PROTOCOL_VERSION, kind: 'leave' }]);
});

test('decodes multiple messages from one TCP read', () => {
  const first = encodeMessage({ v: PROTOCOL_VERSION, kind: 'leave' });
  const second = encodeMessage({
    v: PROTOCOL_VERSION,
    kind: 'participantLeft',
    participantId: 'p1',
    lobbyMetadata: { participantCount: 1 },
  });
  const data = new Uint8Array(first.length + second.length);
  data.set(first);
  data.set(second, first.length);
  assert.deepEqual(new MessageDecoder().push(data), [
    { v: PROTOCOL_VERSION, kind: 'leave' },
    {
      v: PROTOCOL_VERSION,
      kind: 'participantLeft',
      participantId: 'p1',
      lobbyMetadata: { participantCount: 1 },
    },
  ]);
});

test('frames watcher registration and acknowledgement messages', () => {
  const decoder = new MessageDecoder();
  const watch = encodeMessage({ v: PROTOCOL_VERSION, kind: 'watch' });
  const watching = encodeMessage({
    v: PROTOCOL_VERSION,
    kind: 'watching',
    phase: 'lobby',
    lobbyMetadata: { playerCount: 1, spectatorCount: 0, maxPlayers: 6 },
  });

  assert.deepEqual(decoder.push(watch), [{ v: PROTOCOL_VERSION, kind: 'watch' }]);
  assert.deepEqual(decoder.push(watching), [
    {
      v: PROTOCOL_VERSION,
      kind: 'watching',
      phase: 'lobby',
      lobbyMetadata: { playerCount: 1, spectatorCount: 0, maxPlayers: 6 },
    },
  ]);
});

test('rejects unsupported protocol versions', () => {
  const data = new TextEncoder().encode('{"v":2,"kind":"leave"}\n');
  assert.throws(() => new MessageDecoder().push(data), /Unsupported LAN protocol/);
});

test('rejects oversized frames', () => {
  const data = new Uint8Array(MAX_FRAME_BYTES + 1).fill(97);
  assert.throws(() => new MessageDecoder().push(data), /exceeds/);
});
