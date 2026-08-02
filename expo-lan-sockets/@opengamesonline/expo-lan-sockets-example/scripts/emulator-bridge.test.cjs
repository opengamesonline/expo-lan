const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BRIDGE_HOST,
  bridgedServiceName,
  canConnect,
  isBridgeService,
  parseEmulatorDevices,
} = require('./emulator-bridge.cjs');

test('uses a sidecar-specific hostname for proxy advertisements', () => {
  assert.match(BRIDGE_HOST, /^expo-lan-bridge-\d+-[a-z0-9]{6}\.local$/);
});

test('keeps the multiplayer advertisement format for bridge services', () => {
  const name = bridgedServiceName('Tile Clash~abc123~def456', 'emulator-5554');

  assert.match(
    name,
    /^Tile Clash \[bridge emulator-5554\]~[a-z0-9]{6}~[a-z0-9]{6}$/
  );
  assert.equal(isBridgeService({ name }), true);
  assert.equal(isBridgeService({ name: 'Tile Clash~abc123~def456' }), false);
});

test('parses all online Android emulators from adb output', () => {
  const output = [
    'List of devices attached',
    'emulator-5556\tdevice product:sdk_gphone model:Pixel',
    'R5CT11\tdevice product:physical',
    'emulator-5554\tdevice product:sdk_gphone model:Pixel',
    'emulator-5558\toffline',
    '',
  ].join('\n');

  assert.deepEqual(parseEmulatorDevices(output), ['emulator-5554', 'emulator-5556']);
});

test('detects whether an ADB forwarding port accepts connections', async (t) => {
  const server = require('node:net').createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  assert.equal(await canConnect(server.address().port), true);
});
