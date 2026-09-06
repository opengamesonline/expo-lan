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

function parseIpv4Addresses(output) {
  return [...output.matchAll(/\binet\s+(\d+(?:\.\d+){3})\//g)].map((match) => match[1]);
}

function matchingEmulator(service, devices) {
  for (const address of service.addresses || []) {
    const matches = devices.filter((device) => device.addresses.includes(address));
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

async function listEmulatorDevices() {
  const { stdout } = await execFileAsync('adb', ['devices']);
  const serials = parseEmulatorDevices(stdout);
  return Promise.all(
    serials.map(async (serial) => {
      const { stdout: addresses } = await execFileAsync('adb', [
        '-s',
        serial,
        'shell',
        'ip',
        '-o',
        '-4',
        'addr',
        'show',
        'scope',
        'global',
      ]);
      return { serial, addresses: parseIpv4Addresses(addresses) };
    })
  );
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
  const devicesAtStart = [...emulatorDevices];

  try {
    const device = matchingEmulator(service, devicesAtStart);
    if (!device) {
      const addresses = service.addresses?.join(', ') || 'unresolved';
      console.log(`No emulator address matches ${service.name} at ${addresses}`);
      return;
    }

    let adbPort;
    let relay;
    let sockets;
    let activated = false;
    try {
      adbPort = await createAdbForward(device.serial, service.port);
      if (!(await canConnect(adbPort))) {
        console.log(
          `${service.name} is not accepting connections on ${device.serial}:${service.port}`
        );
        return;
      }
      if (
        stopping ||
        !sourceServices.has(key) ||
        !emulatorDevices.some((candidate) => candidate.serial === device.serial)
      ) {
        return;
      }

      ({ relay, sockets } = createRelay(adbPort, service));
      await listen(relay);
      const relayAddress = relay.address();
      if (!relayAddress || typeof relayAddress === 'string') {
        throw new Error('TCP relay has no port');
      }
      const publication = bonjour.publish({
        host: BRIDGE_HOST,
        name: bridgedServiceName(service.name, device.serial),
        type: SERVICE_TYPE,
        protocol: 'tcp',
        port: relayAddress.port,
      });
      publication.on('error', (error) => {
        console.error(`Could not advertise bridge for ${service.name}: ${error.message}`);
      });

      bridges.set(key, { adbPort, device: device.serial, publication, relay, service, sockets });
      activated = true;
      console.log(
        `Bridged ${service.name}: Mac:${relayAddress.port} -> ${device.serial}:${service.port}`
      );
    } catch (error) {
      console.error(`Could not bridge ${service.name} on ${device.serial}: ${error.message}`);
    } finally {
      if (!activated) {
        sockets?.forEach((socket) => socket.destroy());
        if (relay?.listening) await closeServer(relay);
        if (adbPort) await removeAdbForward(device.serial, adbPort);
      }
    }
  } finally {
    pendingServices.delete(key);
    const startingSerials = devicesAtStart.map((device) => device.serial);
    const hasNewDevice = emulatorDevices.some(
      (device) => !startingSerials.includes(device.serial)
    );
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
    const nextIdentity = nextDevices
      .map((device) => `${device.serial}:${device.addresses.join(',')}`)
      .join('\0');
    const currentIdentity = emulatorDevices
      .map((device) => `${device.serial}:${device.addresses.join(',')}`)
      .join('\0');
    if (nextIdentity === currentIdentity) return;

    const changedDevices = emulatorDevices
      .filter((device) => {
        const nextDevice = nextDevices.find((candidate) => candidate.serial === device.serial);
        return !nextDevice || nextDevice.addresses.join(',') !== device.addresses.join(',');
      })
      .map((device) => device.serial);
    emulatorDevices = nextDevices;
    console.log(
      emulatorDevices.length > 0
        ? `Watching Android emulators: ${emulatorDevices
            .map((device) => `${device.serial} (${device.addresses.join(', ')})`)
            .join(', ')}`
        : 'Waiting for an Android emulator'
    );

    await Promise.all(
      [...bridges]
        .filter(([, bridge]) => changedDevices.includes(bridge.device))
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
  matchingEmulator,
  parseEmulatorDevices,
  parseIpv4Addresses,
};
