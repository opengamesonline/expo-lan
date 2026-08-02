import { encodeMessage, MessageDecoder, PROTOCOL_VERSION, type WireMessage } from './protocol';
import type { SessionTransport } from './SessionTransport';
import type {
  CreateGameOptions,
  GamePhase,
  Player,
  SessionListener,
  SessionRole,
  SessionSnapshot,
  SessionStatus,
} from './types';

type SessionOwner = {
  sessionEnded(session: GameSession<unknown, unknown>): void;
};

export class GameSession<State, GameEvent> {
  private readonly listeners = new Set<SessionListener<State>>();
  private readonly decoders = new Map<string, MessageDecoder<State, GameEvent>>();
  private readonly connectionPlayers = new Map<string, Player>();
  private readonly playerConnections = new Map<string, string>();
  private connectionId: string | null = null;
  private status: SessionStatus;
  private phase: GamePhase = 'lobby';
  private state: State | null;
  private revision = 0;
  private self: Player | null;
  private players: Player[];
  private error: string | null = null;

  private constructor(
    private readonly owner: SessionOwner,
    private readonly transport: SessionTransport,
    readonly role: SessionRole,
    state: State | null,
    private readonly hostOptions?: CreateGameOptions<State, GameEvent>
  ) {
    this.state = state;
    this.status = role === 'host' ? 'connected' : 'connecting';
    this.self = role === 'host' ? createPlayer(hostOptions?.playerName ?? 'Host', 0) : null;
    this.players = this.self ? [this.self] : [];
  }

  static host<State, GameEvent>(
    owner: SessionOwner,
    transport: SessionTransport,
    options: CreateGameOptions<State, GameEvent>
  ): GameSession<State, GameEvent> {
    return new GameSession(owner, transport, 'host', options.initialState, options);
  }

  static client<State, GameEvent>(
    owner: SessionOwner,
    transport: SessionTransport
  ): GameSession<State, GameEvent> {
    return new GameSession<State, GameEvent>(owner, transport, 'client', null);
  }

  get snapshot(): SessionSnapshot<State> {
    return {
      role: this.role,
      status: this.status,
      phase: this.phase,
      state: this.state,
      revision: this.revision,
      self: this.self,
      players: [...this.players],
      error: this.error,
    };
  }

  subscribe(listener: SessionListener<State>): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async sendGameEvent(event: GameEvent): Promise<void> {
    if (this.status !== 'connected' || !this.self) throw new Error('The game session is not connected');
    if (this.phase !== 'started') throw new Error('The game has not started');
    if (this.role === 'host') {
      await this.applyEvent(event, this.self);
      return;
    }
    await this.sendToServer({ v: PROTOCOL_VERSION, kind: 'gameEvent', event });
  }

  async startGame(): Promise<void> {
    if (this.role !== 'host') throw new Error('Only the host can start the game');
    if (this.status !== 'connected') throw new Error('The game session is not connected');
    if (this.phase === 'started') return;
    if (this.state === null) throw new Error('The game state is not ready');
    this.phase = 'started';
    this.emit();
    await this.broadcast({
      v: PROTOCOL_VERSION,
      kind: 'gameStarted',
      state: this.state,
      revision: this.revision,
    });
  }

  async leaveGame(): Promise<void> {
    if (this.status === 'left') return;
    const wasDisconnected = this.status === 'disconnected';
    this.status = 'left';
    this.emit();
    try {
      if (this.role === 'host') {
        await this.transport.stopServerAsync();
      } else if (this.connectionId && !wasDisconnected) {
        try {
          await this.sendToServer({ v: PROTOCOL_VERSION, kind: 'leave' });
        } finally {
          await this.transport.disconnectAsync(this.connectionId);
        }
      }
    } finally {
      this.owner.sessionEnded(this as GameSession<unknown, unknown>);
    }
  }

  attachIncoming(connectionId: string): void {
    if (this.role !== 'host') return;
    this.decoders.set(connectionId, new MessageDecoder());
  }

  async attachServer(connectionId: string, playerName: string): Promise<void> {
    this.connectionId = connectionId;
    this.decoders.set(connectionId, new MessageDecoder());
    await this.sendToServer({ v: PROTOCOL_VERSION, kind: 'join', playerName: cleanName(playerName) });
  }

  receive(connectionId: string, data: Uint8Array): void {
    const decoder = this.decoders.get(connectionId);
    if (!decoder) return;
    try {
      for (const message of decoder.push(data)) void this.handleMessage(connectionId, message);
    } catch (cause) {
      this.fail(cause instanceof Error ? cause.message : 'Invalid LAN message');
      void this.transport.disconnectAsync(connectionId);
    }
  }

  disconnected(connectionId: string): void {
    this.decoders.delete(connectionId);
    if (this.role === 'client' && connectionId === this.connectionId && this.status !== 'left') {
      this.status = 'disconnected';
      this.error = 'The host disconnected';
      this.players = this.self ? [this.self] : [];
      this.emit();
      return;
    }
    if (this.role === 'host') void this.removePlayer(connectionId);
  }

  fail(message: string): void {
    this.error = message;
    this.emit();
  }

  private async handleMessage(
    connectionId: string,
    message: WireMessage<State, GameEvent>
  ): Promise<void> {
    if (this.role === 'host') {
      await this.handleHostMessage(connectionId, message);
    } else {
      this.handleClientMessage(message);
    }
  }

  private async handleHostMessage(
    connectionId: string,
    message: WireMessage<State, GameEvent>
  ): Promise<void> {
    if (message.kind === 'join') {
      await this.acceptPlayer(connectionId, message.playerName);
      return;
    }
    const player = this.connectionPlayers.get(connectionId);
    if (!player) return;
    if (message.kind === 'gameEvent') await this.applyEvent(message.event, player);
    if (message.kind === 'leave') {
      await this.removePlayer(connectionId);
      await this.transport.disconnectAsync(connectionId);
    }
  }

  private handleClientMessage(message: WireMessage<State, GameEvent>): void {
    if (message.kind === 'welcome') {
      this.self = message.self;
      this.players = message.players;
      this.state = message.state;
      this.revision = message.revision;
      this.phase = message.phase;
      this.status = 'connected';
      this.emit();
    } else if (message.kind === 'playerJoined') {
      this.players = [...this.players.filter((player) => player.id !== message.player.id), message.player];
      this.emit();
    } else if (message.kind === 'playerLeft') {
      this.players = this.players.filter((player) => player.id !== message.playerId);
      this.emit();
    } else if (message.kind === 'gameStarted') {
      this.state = message.state;
      this.revision = message.revision;
      this.phase = 'started';
      this.emit();
    } else if (message.kind === 'state' && message.revision >= this.revision) {
      this.state = message.state;
      this.revision = message.revision;
      this.emit();
    } else if (message.kind === 'rejected') {
      this.status = 'disconnected';
      this.fail(message.reason);
    }
  }

  private async acceptPlayer(connectionId: string, playerName: string): Promise<void> {
    if (this.connectionPlayers.has(connectionId)) return;
    if (this.state === null) throw new Error('The host state is not ready');
    if (this.phase === 'started') {
      await this.send(connectionId, { v: PROTOCOL_VERSION, kind: 'rejected', reason: 'The game has already started' });
      await this.transport.disconnectAsync(connectionId);
      return;
    }
    const maxPlayers = this.hostOptions?.maxPlayers ?? 8;
    if (this.players.length >= maxPlayers) {
      await this.send(connectionId, { v: PROTOCOL_VERSION, kind: 'rejected', reason: 'The game is full' });
      await this.transport.disconnectAsync(connectionId);
      return;
    }

    const usedSlots = new Set(this.players.map((player) => player.slot));
    let slot = 1;
    while (usedSlots.has(slot)) slot += 1;
    const player = createPlayer(cleanName(playerName), slot);
    this.connectionPlayers.set(connectionId, player);
    this.playerConnections.set(player.id, connectionId);
    this.players = [...this.players, player];
    await this.send(connectionId, {
      v: PROTOCOL_VERSION,
      kind: 'welcome',
      self: player,
      players: this.players,
      state: this.state,
      revision: this.revision,
      phase: this.phase,
    });
    await this.broadcast({ v: PROTOCOL_VERSION, kind: 'playerJoined', player }, connectionId);
    this.emit();
  }

  private async removePlayer(connectionId: string): Promise<void> {
    const player = this.connectionPlayers.get(connectionId);
    if (!player) return;
    this.connectionPlayers.delete(connectionId);
    this.playerConnections.delete(player.id);
    this.players = this.players.filter((candidate) => candidate.id !== player.id);
    await this.broadcast({ v: PROTOCOL_VERSION, kind: 'playerLeft', playerId: player.id });
    this.emit();
  }

  private async applyEvent(event: GameEvent, player: Player): Promise<void> {
    if (!this.hostOptions || this.state === null) return;
    this.state = this.hostOptions.reduceEvent(this.state, event, player);
    this.revision += 1;
    await this.broadcast({ v: PROTOCOL_VERSION, kind: 'state', state: this.state, revision: this.revision });
    this.emit();
  }

  private async sendToServer(message: WireMessage<State, GameEvent>): Promise<void> {
    if (!this.connectionId) throw new Error('The server connection is not ready');
    await this.send(this.connectionId, message);
  }

  private async send(connectionId: string, message: WireMessage<State, GameEvent>): Promise<void> {
    await this.transport.sendAsync(connectionId, encodeMessage(message));
  }

  private async broadcast(
    message: WireMessage<State, GameEvent>,
    excludedConnectionId?: string
  ): Promise<void> {
    const data = encodeMessage(message);
    const sends = [...this.playerConnections.values()]
      .filter((connectionId) => connectionId !== excludedConnectionId)
      .map((connectionId) => this.transport.sendAsync(connectionId, data));
    await Promise.all(sends);
  }

  private emit(): void {
    const snapshot = this.snapshot;
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

function createPlayer(name: string, slot: number): Player {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    name: cleanName(name),
    slot,
  };
}

function cleanName(name: string): string {
  return name.trim().slice(0, 24) || 'Player';
}
