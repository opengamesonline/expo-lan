import assert from 'node:assert/strict';
import test from 'node:test';

import { GameSession } from '../src/GameSession';
import { encodeMessage, MessageDecoder, type WireMessage } from '../src/protocol';
import type { SessionTransport } from '../src/SessionTransport';

type TileState = { tiles: Array<number | null> };
type TileEvent = { type: 'claimTile'; tile: number };
type TestSession = GameSession<TileState, TileEvent>;
type SessionPeer = Pick<TestSession, 'receive' | 'disconnected'>;

class SessionOwner {
  ended = 0;

  sessionEnded(_session: GameSession<unknown, unknown>): void {
    this.ended += 1;
  }
}

type Link = {
  client: SessionPeer;
  clientConnectionId: string;
};

class WatchPeer implements SessionPeer {
  readonly messages: Array<WireMessage<TileState, TileEvent>> = [];
  disconnectedFromHost = false;
  private readonly decoder = new MessageDecoder<TileState, TileEvent>();

  receive(_connectionId: string, data: Uint8Array): void {
    this.messages.push(...this.decoder.push(data));
  }

  disconnected(_connectionId: string): void {
    this.disconnectedFromHost = true;
  }
}

class HostTransport implements SessionTransport {
  host!: TestSession;
  readonly links = new Map<string, Link>();
  delaySends = false;

  async sendAsync(connectionId: string, data: Uint8Array): Promise<void> {
    if (this.delaySends) await settle();
    const link = this.links.get(connectionId);
    if (!link) throw new Error(`Unknown host connection ${connectionId}`);
    link.client.receive(link.clientConnectionId, data.slice());
    await settle();
  }

  async disconnectAsync(connectionId: string): Promise<void> {
    this.disconnect(connectionId);
  }

  async stopServerAsync(): Promise<void> {
    [...this.links.keys()].forEach((connectionId) => this.disconnect(connectionId));
  }

  disconnect(connectionId: string): void {
    const link = this.links.get(connectionId);
    if (!link) return;
    this.links.delete(connectionId);
    this.host.disconnected(connectionId);
    link.client.disconnected(link.clientConnectionId);
  }
}

class ClientTransport implements SessionTransport {
  client!: TestSession;

  constructor(
    private readonly hostTransport: HostTransport,
    private readonly hostConnectionId: string,
    private readonly clientConnectionId: string
  ) {}

  async sendAsync(connectionId: string, data: Uint8Array): Promise<void> {
    assert.equal(connectionId, this.clientConnectionId);
    this.hostTransport.host.receive(this.hostConnectionId, data.slice());
    await settle();
  }

  async disconnectAsync(connectionId: string): Promise<void> {
    assert.equal(connectionId, this.clientConnectionId);
    this.hostTransport.disconnect(this.hostConnectionId);
  }

  async stopServerAsync(): Promise<void> {
    throw new Error('A client cannot stop the server');
  }
}

function createHost(capacity: { minPlayers?: number; maxPlayers?: number } = {}) {
  const owner = new SessionOwner();
  const transport = new HostTransport();
  const session = GameSession.host<TileState, TileEvent>(owner, transport, {
    name: 'Test game',
    playerName: 'Host',
    initialState: { tiles: Array<number | null>(9).fill(null) },
    ...capacity,
    reduceEvent(state, event, player) {
      const tiles = [...state.tiles];
      if (event.type === 'claimTile' && event.tile >= 0 && event.tile < tiles.length) {
        tiles[event.tile] = player.slot;
      }
      return { tiles };
    },
  });
  transport.host = session;
  return { owner, session, transport };
}

async function joinClient(host: ReturnType<typeof createHost>, index = 1) {
  const owner = new SessionOwner();
  const hostConnectionId = `host-${index}`;
  const clientConnectionId = `client-${index}`;
  const transport = new ClientTransport(host.transport, hostConnectionId, clientConnectionId);
  const session = GameSession.client<TileState, TileEvent>(owner, transport);
  transport.client = session;
  host.transport.links.set(hostConnectionId, { client: session, clientConnectionId });
  host.session.attachIncoming(hostConnectionId);
  await session.attachServer(clientConnectionId, `Client ${index}`);
  await settle();
  return { owner, session, transport };
}

async function watchHost(host: ReturnType<typeof createHost>, index = 1) {
  const hostConnectionId = `host-watch-${index}`;
  const clientConnectionId = `client-watch-${index}`;
  const peer = new WatchPeer();
  host.transport.links.set(hostConnectionId, { client: peer, clientConnectionId });
  host.session.attachIncoming(hostConnectionId);
  host.session.receive(hostConnectionId, encodeMessage({ v: 1, kind: 'watch' }));
  await settle();
  return peer;
}

test('creates a lobby and joins a client', async () => {
  const host = createHost();
  const client = await joinClient(host);

  assert.equal(host.session.snapshot.phase, 'lobby');
  assert.equal(client.session.snapshot.phase, 'lobby');
  assert.equal(client.session.snapshot.status, 'connected');
  assert.deepEqual(host.session.snapshot.players.map((player) => player.name), ['Host', 'Client 1']);
  assert.deepEqual(client.session.snapshot.players.map((player) => player.name), ['Host', 'Client 1']);
});

test('only the host can start and clients receive the transition', async () => {
  const host = createHost();
  const client = await joinClient(host);

  await assert.rejects(client.session.startGame(), /Only the host/);
  await host.session.startGame();
  await settle();

  assert.equal(host.session.snapshot.phase, 'started');
  assert.equal(client.session.snapshot.phase, 'started');
});

test('enforces minimum and maximum lobby capacity', async () => {
  const host = createHost({ minPlayers: 2, maxPlayers: 2 });

  assert.deepEqual(host.session.snapshot.lobby, {
    playerCount: 1,
    minPlayers: 2,
    maxPlayers: 2,
  });
  await assert.rejects(host.session.startGame(), /At least 2 players/);

  const client = await joinClient(host, 1);
  assert.equal(client.session.snapshot.status, 'connected');
  assert.deepEqual(client.session.snapshot.lobby, {
    playerCount: 2,
    minPlayers: 2,
    maxPlayers: 2,
  });

  const rejectedClient = await joinClient(host, 2);
  assert.equal(rejectedClient.session.snapshot.status, 'disconnected');
  assert.equal(host.session.snapshot.players.length, 2);
  await host.session.startGame();
});

test('synchronizes an authoritative tile update', async () => {
  const host = createHost();
  const client = await joinClient(host);
  await host.session.startGame();

  await client.session.sendGameEvent({ type: 'claimTile', tile: 4 });
  await settle();

  const clientSlot = client.session.snapshot.self?.slot;
  assert.equal(host.session.snapshot.state?.tiles[4], clientSlot);
  assert.equal(client.session.snapshot.state?.tiles[4], clientSlot);
  assert.equal(host.session.snapshot.revision, 1);
  assert.equal(client.session.snapshot.revision, 1);
});

test('removes a client that leaves the lobby', async () => {
  const host = createHost();
  const client = await joinClient(host);

  await client.session.leaveGame();
  await settle();

  assert.deepEqual(host.session.snapshot.players.map((player) => player.name), ['Host']);
  assert.equal(client.session.snapshot.status, 'left');
  assert.equal(client.owner.ended, 1);
});

test('notifies a client when the host closes the lobby', async () => {
  const host = createHost();
  const client = await joinClient(host);

  await host.session.leaveGame();
  await settle();

  assert.equal(client.session.snapshot.status, 'disconnected');
  assert.deepEqual(client.session.snapshot.players.map((player) => player.name), ['Client 1']);
  assert.equal(host.owner.ended, 1);
});

test('keeps watchers out of the player list and closes them when the game starts', async () => {
  const host = createHost();
  const watcher = await watchHost(host);

  assert.deepEqual(watcher.messages, [
    {
      v: 1,
      kind: 'watching',
      phase: 'lobby',
      lobby: { playerCount: 1, minPlayers: 1, maxPlayers: 8 },
    },
  ]);
  assert.deepEqual(host.session.snapshot.players.map((player) => player.name), ['Host']);

  await host.session.startGame();
  await settle();

  assert.equal(watcher.disconnectedFromHost, true);
});

test('updates watchers when lobby occupancy changes', async () => {
  const host = createHost({ minPlayers: 2, maxPlayers: 4 });
  const watcher = await watchHost(host);
  const client = await joinClient(host);

  assert.deepEqual(watcher.messages.map((message) => message.kind === 'watching' && message.lobby), [
    { playerCount: 1, minPlayers: 2, maxPlayers: 4 },
    { playerCount: 2, minPlayers: 2, maxPlayers: 4 },
  ]);

  await client.session.leaveGame();
  await settle();

  assert.deepEqual(watcher.messages.at(-1), {
    v: 1,
    kind: 'watching',
    phase: 'lobby',
    lobby: { playerCount: 1, minPlayers: 2, maxPlayers: 4 },
  });
});

test('closes watcher connections when the host cancels the game', async () => {
  const host = createHost();
  const watcher = await watchHost(host);

  await host.session.leaveGame();
  await settle();

  assert.equal(watcher.disconnectedFromHost, true);
});

test('closes a host with multiple clients without rejected cleanup sends', async () => {
  const host = createHost();
  await joinClient(host, 1);
  await joinClient(host, 2);
  await joinClient(host, 3);
  host.transport.delaySends = true;

  await host.session.leaveGame();
  await settle();

  assert.equal(host.session.snapshot.status, 'left');
  assert.deepEqual(host.session.snapshot.players.map((player) => player.name), ['Host']);
});

test('rejects a late join after the game starts', async () => {
  const host = createHost();
  await host.session.startGame();
  const client = await joinClient(host);

  assert.equal(client.session.snapshot.status, 'disconnected');
  assert.deepEqual(host.session.snapshot.players.map((player) => player.name), ['Host']);
});

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
