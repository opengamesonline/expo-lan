const { execFile } = require('node:child_process');
const net = require('node:net');
const { promisify } = require('node:util');
const Bonjour = require('bonjour-service');

const execFileAsync = promisify(execFile);
const SERVICE_TYPE = 'expo-lan-game';
const DEVICE_POLL_INTERVAL_MS = 2000;
const bridges = new Map();
const pendingServices = new Set();
const sourceServices = new Map();
let emulatorDevices = [];
let refreshingDevices = false;
let stopping = false;

function randomId() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

const BRIDGE_HOST = `expo-lan-bridge-${process.pid}-${randomId()}.local`;

function bridgedServiceName(name, device) {
  const match = name.match(/^(.*)~[a-z0-9]{6}~[a-z0-9]{6}$/);
  const visibleName = match?.[1] || name;
  return `${visibleName} [bridge ${device}]~${randomId()}~${randomId()}`;
}

function isBridgeService(service) {
  return /\[bridge(?:\s[^\]]*)?\]/.test(service.name);
}

function bridgeKey(service) {
  return service.fqdn || `${service.name}\0${service.port}`;
}

function parseEmulatorDevices(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith('emulator-') && state === 'device')
    .map(([serial]) => serial)
    .sort();
}

async function listEmulatorDevices() {
  const { stdout } = await execFileAsync('adb', ['devices']);
  return parseEmulatorDevices(stdout);
}

async function createAdbForward(device, remotePort) {
  const { stdout } = await execFileAsync('adb', [
    '-s',
    device,
    'forward',
    'tcp:0',
    `tcp:${remotePort}`,
  ]);
  const localPort = Number(stdout.trim());
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error(`adb did not return a forwarding port: ${stdout.trim() || '<empty>'}`);
  }
  return localPort;
}

function canConnect(port, timeoutMilliseconds = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(connected);
    };
    const timeout = setTimeout(() => finish(false), timeoutMilliseconds);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '::', port: 0, ipv6Only: false });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function stopPublication(publication) {
  return new Promise((resolve) => publication.stop(resolve));
}

async function removeAdbForward(device, localPort) {
  try {
    await execFileAsync('adb', ['-s', device, 'forward', '--remove', `tcp:${localPort}`]);
  } catch {
    // The emulator or ADB server may already be gone during shutdown.
  }
}

function createRelay(adbPort, service) {
  const sockets = new Set();
  const relay = net.createServer((client) => {
    const upstream = net.createConnection({ host: '127.0.0.1', port: adbPort });
    sockets.add(client);
    sockets.add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    client.on('error', () => upstream.destroy());
    upstream.on('error', (error) => {
      console.error(`Bridge connection failed for ${service.name}: ${error.message}`);
      client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return { relay, sockets };
}

async function startBridge(bonjour, service) {
  const key = bridgeKey(service);
  if (stopping || bridges.has(key) || pendingServices.has(key)) return;
  pendingServices.add(key);
  const devicesToProbe = [...emulatorDevices];

  try {
    for (const device of devicesToProbe) {
      if (stopping) return;
      let adbPort;
      let relay;
      let sockets;
      let activated = false;
      try {
        adbPort = await createAdbForward(device, service.port);
        if (!(await canConnect(adbPort))) continue;
        if (stopping || !sourceServices.has(key) || !emulatorDevices.includes(device)) return;

        ({ relay, sockets } = createRelay(adbPort, service));
        await listen(relay);
        const relayAddress = relay.address();
        if (!relayAddress || typeof relayAddress === 'string') {
          throw new Error('TCP relay has no port');
        }
        const publication = bonjour.publish({
          host: BRIDGE_HOST,
          name: bridgedServiceName(service.name, device),
          type: SERVICE_TYPE,
          protocol: 'tcp',
          port: relayAddress.port,
        });
        publication.on('error', (error) => {
          console.error(`Could not advertise bridge for ${service.name}: ${error.message}`);
        });

        bridges.set(key, { adbPort, device, publication, relay, service, sockets });
        activated = true;
        console.log(
          `Bridged ${service.name}: Mac:${relayAddress.port} -> ${device}:${service.port}`
        );
        return;
      } catch (error) {
        console.error(`Could not probe ${service.name} on ${device}: ${error.message}`);
      } finally {
        if (!activated) {
          sockets?.forEach((socket) => socket.destroy());
          if (relay?.listening) await closeServer(relay);
          if (adbPort) await removeAdbForward(device, adbPort);
        }
      }
    }
    if (devicesToProbe.length > 0) {
      console.log(`No running emulator accepted ${service.name} on port ${service.port}`);
    }
  } finally {
    pendingServices.delete(key);
    const hasNewDevice = emulatorDevices.some((device) => !devicesToProbe.includes(device));
    if (!stopping && !bridges.has(key) && sourceServices.has(key) && hasNewDevice) {
      void startBridge(bonjour, sourceServices.get(key));
    }
  }
}

async function stopBridge(key) {
  const bridge = bridges.get(key);
  if (!bridge) return;
  bridges.delete(key);
  await stopPublication(bridge.publication);
  bridge.sockets.forEach((socket) => socket.destroy());
  await closeServer(bridge.relay);
  await removeAdbForward(bridge.device, bridge.adbPort);
  console.log(`Removed bridge for ${bridge.service.name} on ${bridge.device}`);
}

function scheduleSourceServices(bonjour) {
  sourceServices.forEach((service) => void startBridge(bonjour, service));
}

async function refreshEmulatorDevices(bonjour) {
  if (stopping || refreshingDevices) return;
  refreshingDevices = true;
  try {
    const nextDevices = await listEmulatorDevices();
    if (nextDevices.join('\0') === emulatorDevices.join('\0')) return;

    const removedDevices = emulatorDevices.filter((device) => !nextDevices.includes(device));
    emulatorDevices = nextDevices;
    console.log(
      emulatorDevices.length > 0
        ? `Watching Android emulators: ${emulatorDevices.join(', ')}`
        : 'Waiting for an Android emulator'
    );

    await Promise.all(
      [...bridges]
        .filter(([, bridge]) => removedDevices.includes(bridge.device))
        .map(([key]) => stopBridge(key))
    );
    scheduleSourceServices(bonjour);
  } catch (error) {
    console.error(`Could not refresh Android emulators: ${error.message}`);
  } finally {
    refreshingDevices = false;
  }
}

function waitForPendingServices() {
  return new Promise((resolve) => {
    const check = () => {
      if (pendingServices.size === 0) resolve();
      else setTimeout(check, 25);
    };
    check();
  });
}

async function main() {
  const bonjour = new Bonjour(undefined, (error) => {
    console.error(`Bonjour bridge error: ${error.message}`);
  });
  await refreshEmulatorDevices(bonjour);

  const browser = bonjour.find({ type: SERVICE_TYPE, protocol: 'tcp' });
  const bridgeService = (service) => {
    if (isBridgeService(service)) return;
    sourceServices.set(bridgeKey(service), service);
    void startBridge(bonjour, service);
  };
  browser.on('up', bridgeService);
  browser.on('srv-update', bridgeService);
  browser.on('down', (service) => {
    if (isBridgeService(service)) return;
    const key = bridgeKey(service);
    sourceServices.delete(key);
    void stopBridge(key);
  });

  const deviceTimer = setInterval(
    () => void refreshEmulatorDevices(bonjour),
    DEVICE_POLL_INTERVAL_MS
  );

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(deviceTimer);
    browser.stop();
    await waitForPendingServices();
    await Promise.all([...bridges.keys()].map(stopBridge));
    bonjour.destroy();
  };

  process.once('SIGINT', () => void shutdown().finally(() => process.exit(130)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(143)));

  console.log('Create a game on any Android emulator, then select its [bridge] service on iOS.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`emulator bridge: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BRIDGE_HOST,
  bridgedServiceName,
  canConnect,
  isBridgeService,
  parseEmulatorDevices,
};
