import assert from 'node:assert/strict';
import test from 'node:test';

import { GameSession } from '../src/GameSession';
import {
  encodeMessage,
  MessageDecoder,
  PROTOCOL_VERSION,
  type WireMessage,
} from '../src/protocol';
import type { SessionTransport } from '../src/SessionTransport';

type TileState = {
  tiles: Array<number | null>;
  playerIds: string[];
};
type TileEvent = { type: 'claimTile'; tile: number };
type ParticipantMetadata = { role: 'player' | 'spectator' };
type LobbyMetadata = {
  playerCount: number;
  spectatorCount: number;
  maxPlayers: number;
};
type TestSession = GameSession<
  TileState,
  TileEvent,
  ParticipantMetadata,
  LobbyMetadata
>;
type SessionPeer = Pick<TestSession, 'receive' | 'disconnected'>;

class SessionOwner {
  ended = 0;

  sessionEnded(
    _session: GameSession<unknown, unknown, ParticipantMetadata, LobbyMetadata>
  ): void {
    this.ended += 1;
  }
}

type Link = {
  client: SessionPeer;
  clientConnectionId: string;
};

class WatchPeer implements SessionPeer {
  readonly messages: Array<
    WireMessage<TileState, TileEvent, ParticipantMetadata, LobbyMetadata>
  > = [];
  disconnectedFromHost = false;
  private readonly decoder = new MessageDecoder<
    TileState,
    TileEvent,
    ParticipantMetadata,
    LobbyMetadata
  >();

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
    private hostConnectionId: string,
    private clientConnectionId: string
  ) {}

  retarget(hostConnectionId: string, clientConnectionId: string): void {
    this.hostConnectionId = hostConnectionId;
    this.clientConnectionId = clientConnectionId;
  }

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

function createHost({
  hostRole = 'player',
  minPlayers = 1,
  maxPlayers = 8,
}: {
  hostRole?: ParticipantMetadata['role'];
  minPlayers?: number;
  maxPlayers?: number;
} = {}) {
  let lobbyOffset = 0;
  const owner = new SessionOwner();
  const transport = new HostTransport();
  const session = GameSession.host<
    TileState,
    TileEvent,
    ParticipantMetadata,
    LobbyMetadata
  >(owner, transport, {
    name: 'Test game',
    participantName: 'Host',
    participantMetadata: { role: hostRole },
    createInitialState(participants) {
      return {
        tiles: Array<number | null>(9).fill(null),
        playerIds: participants
          .filter(({ metadata }) => metadata.role === 'player')
          .map(({ id }) => id),
      };
    },
    getLobbyMetadata(participants) {
      return {
        playerCount:
          participants.filter(({ metadata }) => metadata.role === 'player').length + lobbyOffset,
        spectatorCount: participants.filter(({ metadata }) => metadata.role === 'spectator')
          .length,
        maxPlayers,
      };
    },
    validateJoin(candidate, participants) {
      if (participants.some(({ name }) => name === candidate.name)) {
        return 'That participant name is already in use';
      }
      const playerCount = participants.filter(
        ({ metadata }) => metadata.role === 'player'
      ).length;
      return candidate.metadata.role === 'player' && playerCount >= maxPlayers
        ? 'The player roster is full'
        : null;
    },
    validateStart(participants) {
      const playerCount = participants.filter(
        ({ metadata }) => metadata.role === 'player'
      ).length;
      return playerCount < minPlayers ? `At least ${minPlayers} players are required` : null;
    },
    reduceEvent(state, event, participant) {
      if (participant.metadata.role === 'spectator') return state;
      const tiles = [...state.tiles];
      if (event.type === 'claimTile' && event.tile >= 0 && event.tile < tiles.length) {
        tiles[event.tile] = participant.slot;
      }
      return { ...state, tiles };
    },
  });
  transport.host = session;
  return {
    owner,
    session,
    transport,
    addLobbyPlayer() {
      lobbyOffset += 1;
    },
  };
}

async function joinClient(
  host: ReturnType<typeof createHost>,
  index = 1,
  role: ParticipantMetadata['role'] = 'player',
  name = `Client ${index}`
) {
  const owner = new SessionOwner();
  const hostConnectionId = `host-${index}`;
  const clientConnectionId = `client-${index}`;
  const transport = new ClientTransport(host.transport, hostConnectionId, clientConnectionId);
  const session = GameSession.client<
    TileState,
    TileEvent,
    ParticipantMetadata,
    LobbyMetadata
  >(owner, transport);
  transport.client = session;
  host.transport.links.set(hostConnectionId, { client: session, clientConnectionId });
  host.session.attachIncoming(hostConnectionId);
  await session.attachServer(clientConnectionId, name, { role });
  await settle();
  return { owner, session, transport };
}

async function reconnectClient(
  host: ReturnType<typeof createHost>,
  client: Awaited<ReturnType<typeof joinClient>>,
  index = 9
) {
  const hostConnectionId = `host-resume-${index}`;
  const clientConnectionId = `client-resume-${index}`;
  client.transport.retarget(hostConnectionId, clientConnectionId);
  host.transport.links.set(hostConnectionId, {
    client: client.session,
    clientConnectionId,
  });
  host.session.attachIncoming(hostConnectionId);
  await client.session.attachResumedServer(clientConnectionId);
  await settle();
}

async function watchHost(host: ReturnType<typeof createHost>, index = 1) {
  const hostConnectionId = `host-watch-${index}`;
  const clientConnectionId = `client-watch-${index}`;
  const peer = new WatchPeer();
  host.transport.links.set(hostConnectionId, { client: peer, clientConnectionId });
  host.session.attachIncoming(hostConnectionId);
  host.session.receive(
    hostConnectionId,
    encodeMessage({ v: PROTOCOL_VERSION, kind: 'watch' })
  );
  await settle();
  return peer;
}

test('creates a lobby and transports participant metadata', async () => {
  const host = createHost();
  const client = await joinClient(host, 1, 'spectator');

  assert.equal(host.session.snapshot.phase, 'lobby');
  assert.equal(client.session.snapshot.status, 'connected');
  assert.deepEqual(
    client.session.snapshot.participants.map(({ name, metadata }) => ({ name, metadata })),
    [
      { name: 'Host', metadata: { role: 'player' } },
      { name: 'Client 1', metadata: { role: 'spectator' } },
    ]
  );
});

test('only the host can start and state is initialized from the finalized roster', async () => {
  const host = createHost({ hostRole: 'spectator', minPlayers: 2 });
  const firstPlayer = await joinClient(host, 1, 'player');
  const secondPlayer = await joinClient(host, 2, 'player');

  assert.equal(host.session.snapshot.state, null);
  assert.equal(firstPlayer.session.snapshot.state, null);
  await assert.rejects(firstPlayer.session.startGame(), /Only the host/);
  await host.session.startGame();
  await settle();

  assert.equal(host.session.snapshot.phase, 'started');
  assert.deepEqual(host.session.snapshot.state?.playerIds, [
    firstPlayer.session.snapshot.self?.id,
    secondPlayer.session.snapshot.self?.id,
  ]);
  assert.deepEqual(firstPlayer.session.snapshot.state, host.session.snapshot.state);
});

test('enforces app-defined join and start policy', async () => {
  const host = createHost({ minPlayers: 2, maxPlayers: 2 });

  await assert.rejects(host.session.startGame(), /At least 2 players/);
  const player = await joinClient(host, 1, 'player');
  const spectator = await joinClient(host, 2, 'spectator');
  const rejectedPlayer = await joinClient(host, 3, 'player');
  const duplicate = await joinClient(host, 4, 'spectator', 'Client 1');

  assert.equal(player.session.snapshot.status, 'connected');
  assert.equal(spectator.session.snapshot.status, 'connected');
  assert.equal(rejectedPlayer.session.snapshot.status, 'disconnected');
  assert.equal(duplicate.session.snapshot.status, 'disconnected');
  assert.equal(host.session.snapshot.participants.length, 3);
  await host.session.startGame();
});

test('passes the connection-bound participant to the authoritative reducer', async () => {
  const host = createHost();
  const player = await joinClient(host, 1, 'player');
  await host.session.startGame();

  await player.session.sendGameEvent({ type: 'claimTile', tile: 4 });
  await settle();

  assert.equal(host.session.snapshot.state?.tiles[4], player.session.snapshot.self?.slot);
  assert.equal(player.session.snapshot.state?.tiles[4], player.session.snapshot.self?.slot);
  assert.equal(host.session.snapshot.revision, 1);
});

test('allows app policy to ignore spectator game events', async () => {
  const host = createHost();
  const spectator = await joinClient(host, 1, 'spectator');
  await host.session.startGame();

  await spectator.session.sendGameEvent({ type: 'claimTile', tile: 4 });
  await settle();

  assert.equal(host.session.snapshot.state?.tiles[4], null);
});

test('removes a participant that leaves the lobby', async () => {
  const host = createHost();
  const client = await joinClient(host);

  await client.session.leaveGame();
  await settle();

  assert.deepEqual(host.session.snapshot.participants.map(({ name }) => name), ['Host']);
  assert.equal(client.session.snapshot.status, 'left');
  assert.equal(client.owner.ended, 1);
});

test('resumes an unexpectedly disconnected participant with the same identity and state', async () => {
  const host = createHost();
  const client = await joinClient(host);
  const originalSelf = client.session.snapshot.self!;
  await host.session.startGame();
  await client.session.sendGameEvent({ type: 'claimTile', tile: 4 });
  await settle();
  const stateBeforeDisconnect = client.session.snapshot.state;

  host.transport.disconnect('host-1');
  await settle();

  assert.equal(client.session.snapshot.status, 'disconnected');
  assert.equal(host.session.snapshot.participants.some(({ id }) => id === originalSelf.id), true);
  assert.equal(host.session.snapshot.connectedParticipantIds.includes(originalSelf.id), false);
  assert.deepEqual(client.session.snapshot.state, stateBeforeDisconnect);

  await reconnectClient(host, client);

  assert.equal(client.session.snapshot.status, 'connected');
  assert.equal(client.session.snapshot.self?.id, originalSelf.id);
  assert.equal(client.session.snapshot.self?.slot, originalSelf.slot);
  assert.equal(host.session.snapshot.connectedParticipantIds.includes(originalSelf.id), true);
  assert.deepEqual(client.session.snapshot.state, host.session.snapshot.state);
});

test('restores a persisted participant after the client process restarts', async () => {
  const host = createHost();
  const client = await joinClient(host);
  const recovery = client.session.exportRecoveryState();
  const selfId = client.session.snapshot.self!.id;
  host.transport.disconnect('host-1');
  await settle();

  const owner = new SessionOwner();
  const transport = new ClientTransport(host.transport, 'host-restored', 'client-restored');
  const restored = GameSession.restore<
    TileState,
    TileEvent,
    ParticipantMetadata,
    LobbyMetadata
  >(owner, transport, recovery, selfId);
  transport.client = restored;
  host.transport.links.set('host-restored', {
    client: restored,
    clientConnectionId: 'client-restored',
  });
  host.session.attachIncoming('host-restored');
  await restored.attachResumedServer('client-restored');
  await settle();

  assert.equal(restored.snapshot.status, 'connected');
  assert.equal(restored.snapshot.self?.id, selfId);
  assert.equal(restored.snapshot.tableId, host.session.snapshot.tableId);
  assert.deepEqual(restored.snapshot.participants, host.session.snapshot.participants);
});

test('lets the host release a disconnected lobby reservation', async () => {
  const host = createHost();
  const client = await joinClient(host);
  const participantId = client.session.snapshot.self!.id;
  host.transport.disconnect('host-1');
  await settle();

  await host.session.removeDisconnectedParticipant(participantId);
  await settle();

  assert.equal(host.session.snapshot.participants.some(({ id }) => id === participantId), false);
  assert.equal(host.session.snapshot.hostOrder.includes(participantId), false);
  assert.equal(host.session.exportRecoveryState().resumeTokens[participantId], undefined);
});

test('treats a revoked recovery identity as terminal', async () => {
  const host = createHost();
  const client = await joinClient(host);
  const recovery = client.session.exportRecoveryState();
  const selfId = client.session.snapshot.self!.id;
  host.transport.disconnect('host-1');
  await settle();
  await host.session.removeDisconnectedParticipant(selfId);
  await settle();

  const owner = new SessionOwner();
  const transport = new ClientTransport(host.transport, 'host-revoked', 'client-revoked');
  const restored = GameSession.restore<
    TileState,
    TileEvent,
    ParticipantMetadata,
    LobbyMetadata
  >(owner, transport, recovery, selfId);
  transport.client = restored;
  host.transport.links.set('host-revoked', {
    client: restored,
    clientConnectionId: 'client-revoked',
  });
  host.session.attachIncoming('host-revoked');
  await restored.attachResumedServer('client-revoked');
  await settle();

  assert.equal(restored.snapshot.status, 'left');
  assert.match(restored.snapshot.error ?? '', /no longer part|not valid/);
  assert.equal(owner.ended, 1);
  await restored.leaveGame();
  assert.equal(owner.ended, 1);
});

test('promotes above the highest observed authority without changing identity or state', async () => {
  const host = createHost();
  const client = await joinClient(host);
  await host.session.startGame();
  await client.session.sendGameEvent({ type: 'claimTile', tile: 3 });
  await settle();
  const before = client.session.exportRecoveryState();
  const self = client.session.snapshot.self!;
  host.transport.disconnect('host-1');
  await settle();

  client.session.beginPromotion(
    {
      name: before.name,
      participantName: self.name,
      participantMetadata: self.metadata,
      createInitialState: () => ({ tiles: Array(9).fill(null), playerIds: [] }),
      getLobbyMetadata: () => before.lobbyMetadata,
      reduceEvent(state, event, participant) {
        const tiles = [...state.tiles];
        if (event.type === 'claimTile') tiles[event.tile] = participant.slot;
        return { ...state, tiles };
      },
    },
    before.authorityTerm + 2
  );
  client.session.commitPromotion();

  assert.equal(client.session.snapshot.role, 'host');
  assert.equal(client.session.snapshot.self?.id, self.id);
  assert.equal(client.session.snapshot.hostParticipantId, self.id);
  assert.equal(client.session.snapshot.authorityTerm, before.authorityTerm + 3);
  assert.deepEqual(client.session.snapshot.state, before.state);
});

test('notifies a client when the host closes the lobby', async () => {
  const host = createHost();
  const client = await joinClient(host);

  await host.session.leaveGame();
  await settle();

  assert.equal(client.session.snapshot.status, 'left');
  assert.deepEqual(client.session.snapshot.participants.map(({ name }) => name), ['Host', 'Client 1']);
  assert.equal(host.owner.ended, 1);
});

test('keeps watchers out of the participant roster and closes them on start', async () => {
  const host = createHost();
  const watcher = await watchHost(host);

  assert.deepEqual(watcher.messages, [
    {
      v: PROTOCOL_VERSION,
      kind: 'watching',
      phase: 'lobby',
      lobbyMetadata: { playerCount: 1, spectatorCount: 0, maxPlayers: 8 },
    },
  ]);
  assert.deepEqual(host.session.snapshot.participants.map(({ name }) => name), ['Host']);

  await host.session.startGame();
  await settle();

  assert.equal(watcher.disconnectedFromHost, true);
});

test('publishes live opaque lobby metadata when participants change', async () => {
  const host = createHost({ maxPlayers: 4 });
  const watcher = await watchHost(host);
  const spectator = await joinClient(host, 1, 'spectator');

  assert.deepEqual(
    watcher.messages.map(
      (message) => message.kind === 'watching' && message.lobbyMetadata
    ),
    [
      { playerCount: 1, spectatorCount: 0, maxPlayers: 4 },
      { playerCount: 1, spectatorCount: 1, maxPlayers: 4 },
    ]
  );

  await spectator.session.leaveGame();
  await settle();

  assert.deepEqual(watcher.messages.at(-1), {
    v: PROTOCOL_VERSION,
    kind: 'watching',
    phase: 'lobby',
    lobbyMetadata: { playerCount: 1, spectatorCount: 0, maxPlayers: 4 },
  });
});

test('lets the host refresh opaque lobby metadata for clients and watchers', async () => {
  const host = createHost({ maxPlayers: 4 });
  const client = await joinClient(host);
  const watcher = await watchHost(host);

  host.addLobbyPlayer();
  await host.session.refreshLobbyMetadata();
  await settle();

  assert.equal(host.session.snapshot.lobbyMetadata?.playerCount, 3);
  assert.equal(client.session.snapshot.lobbyMetadata?.playerCount, 3);
  assert.deepEqual(watcher.messages.at(-1), {
    v: PROTOCOL_VERSION,
    kind: 'watching',
    phase: 'lobby',
    lobbyMetadata: { playerCount: 3, spectatorCount: 0, maxPlayers: 4 },
  });
  await assert.rejects(client.session.refreshLobbyMetadata(), /Only the host/);

  await host.session.startGame();
  await assert.rejects(host.session.refreshLobbyMetadata(), /already started/);
});

test('returns connected participants to the lobby and starts another round', async () => {
  const host = createHost({ maxPlayers: 4 });
  const client = await joinClient(host);
  const participantIds = host.session.snapshot.participants.map(({ id }) => id);

  await assert.rejects(client.session.returnToLobby(), /Only the host/);
  await host.session.startGame();
  await client.session.sendGameEvent({ type: 'claimTile', tile: 2 });
  host.addLobbyPlayer();
  await host.session.returnToLobby();
  await settle();

  assert.equal(host.session.snapshot.phase, 'lobby');
  assert.equal(client.session.snapshot.phase, 'lobby');
  assert.equal(host.session.snapshot.state, null);
  assert.equal(client.session.snapshot.state, null);
  assert.deepEqual(host.session.snapshot.participants.map(({ id }) => id), participantIds);
  assert.deepEqual(client.session.snapshot.participants.map(({ id }) => id), participantIds);
  assert.equal(client.session.snapshot.lobbyMetadata?.playerCount, 3);
  assert.equal(host.session.snapshot.revision, 1);

  await host.session.returnToLobby();
  const latePlayer = await joinClient(host, 2);
  await host.session.startGame();
  await latePlayer.session.sendGameEvent({ type: 'claimTile', tile: 5 });
  await settle();

  assert.equal(host.session.snapshot.phase, 'started');
  assert.equal(host.session.snapshot.state?.playerIds.length, 3);
  assert.equal(host.session.snapshot.state?.tiles[5], latePlayer.session.snapshot.self?.slot);
  assert.equal(client.session.snapshot.revision, 2);
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
  assert.deepEqual(host.session.snapshot.participants.map(({ name }) => name), [
    'Host',
    'Client 1',
    'Client 2',
    'Client 3',
  ]);
});

test('rejects a late join after the game starts', async () => {
  const host = createHost();
  await host.session.startGame();
  const client = await joinClient(host);

  assert.equal(client.session.snapshot.status, 'disconnected');
  assert.deepEqual(host.session.snapshot.participants.map(({ name }) => name), ['Host']);
});

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
