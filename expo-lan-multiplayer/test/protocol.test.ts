import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_FRAME_BYTES, MessageDecoder, encodeMessage } from '../src/protocol';

test('decodes a message split across TCP reads', () => {
  const encoded = encodeMessage({ v: 1, kind: 'leave' });
  const decoder = new MessageDecoder();
  assert.deepEqual(decoder.push(encoded.slice(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.slice(3)), [{ v: 1, kind: 'leave' }]);
});

test('decodes multiple messages from one TCP read', () => {
  const first = encodeMessage({ v: 1, kind: 'leave' });
  const second = encodeMessage({ v: 1, kind: 'playerLeft', playerId: 'p1' });
  const data = new Uint8Array(first.length + second.length);
  data.set(first);
  data.set(second, first.length);
  assert.deepEqual(new MessageDecoder().push(data), [
    { v: 1, kind: 'leave' },
    { v: 1, kind: 'playerLeft', playerId: 'p1' },
  ]);
});

test('frames watcher registration and acknowledgement messages', () => {
  const decoder = new MessageDecoder();
  const watch = encodeMessage({ v: 1, kind: 'watch' });
  const watching = encodeMessage({
    v: 1,
    kind: 'watching',
    phase: 'lobby',
    lobby: { playerCount: 1, minPlayers: 2, maxPlayers: 6 },
  });

  assert.deepEqual(decoder.push(watch), [{ v: 1, kind: 'watch' }]);
  assert.deepEqual(decoder.push(watching), [
    {
      v: 1,
      kind: 'watching',
      phase: 'lobby',
      lobby: { playerCount: 1, minPlayers: 2, maxPlayers: 6 },
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
