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

test('frames returning a completed round to the lobby', () => {
  const message = encodeMessage({
    v: PROTOCOL_VERSION,
    kind: 'returnedToLobby',
    lobbyMetadata: { playerCount: 3 },
  });

  assert.deepEqual(new MessageDecoder().push(message), [
    {
      v: PROTOCOL_VERSION,
      kind: 'returnedToLobby',
      lobbyMetadata: { playerCount: 3 },
    },
  ]);
});

test('frames heartbeat requests and acknowledgements', () => {
  const decoder = new MessageDecoder();
  const heartbeat = { v: PROTOCOL_VERSION, kind: 'heartbeat' as const, sentAt: 1234 };
  const acknowledgement = {
    v: PROTOCOL_VERSION,
    kind: 'heartbeatAck' as const,
    sentAt: 1234,
  };

  assert.deepEqual(decoder.push(encodeMessage(heartbeat)), [heartbeat]);
  assert.deepEqual(decoder.push(encodeMessage(acknowledgement)), [acknowledgement]);
});

test('frames resume requests and authoritative recovery snapshots', () => {
  const decoder = new MessageDecoder();
  const resume = encodeMessage({
    v: PROTOCOL_VERSION,
    kind: 'resume',
    tableId: 'table1234567',
    participantId: 'p1',
    resumeToken: 'resume-token-123456',
  });
  const sync = encodeMessage({
    v: PROTOCOL_VERSION,
    kind: 'sync',
    recovery: {
      name: 'Table',
      tableId: 'table1234567',
      authorityTerm: 2,
      hostParticipantId: 'p2',
      hostOrder: ['p1', 'p2'],
      resumeTokens: { p1: 'resume-token-123456', p2: 'resume-token-654321' },
      participants: [],
      connectedParticipantIds: ['p2'],
      state: { turn: 4 },
      revision: 4,
      phase: 'started',
      lobbyMetadata: { playerCount: 2 },
    },
  });

  assert.deepEqual(decoder.push(resume), [
    {
      v: PROTOCOL_VERSION,
      kind: 'resume',
      tableId: 'table1234567',
      participantId: 'p1',
      resumeToken: 'resume-token-123456',
    },
  ]);
  assert.equal(decoder.push(sync)[0]?.kind, 'sync');
});

test('rejects unsupported protocol versions', () => {
  const data = new TextEncoder().encode(
    `{"v":${PROTOCOL_VERSION + 1},"kind":"leave"}\n`
  );
  assert.throws(() => new MessageDecoder().push(data), /Unsupported LAN protocol/);
});

test('rejects oversized frames', () => {
  const data = new Uint8Array(MAX_FRAME_BYTES + 1).fill(97);
  assert.throws(() => new MessageDecoder().push(data), /exceeds/);
});
