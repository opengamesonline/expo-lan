const test = require('node:test');
const assert = require('node:assert/strict');

const { MessageDecoder, encodeMessage } = require('../build/protocol');

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
