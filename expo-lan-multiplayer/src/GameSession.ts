import { encodeMessage, MessageDecoder, PROTOCOL_VERSION, type WireMessage } from './protocol';
import type { SessionTransport } from './SessionTransport';
import type {
  CreateGameOptions,
  GamePhase,
  JsonValue,
  Participant,
  SessionListener,
  SessionRole,
  SessionSnapshot,
  SessionStatus,
} from './types';

type SessionOwner<
  ParticipantMetadata extends JsonValue,
  LobbyMetadata extends JsonValue,
> = {
  sessionEnded(
    session: GameSession<unknown, unknown, ParticipantMetadata, LobbyMetadata>
  ): void;
};

export class GameSession<
  State,
  GameEvent,
  ParticipantMetadata extends JsonValue = JsonValue,
  LobbyMetadata extends JsonValue = JsonValue,
> {
  private readonly listeners = new Set<
    SessionListener<State, ParticipantMetadata, LobbyMetadata>
  >();
  private readonly decoders = new Map<
    string,
    MessageDecoder<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  >();
  private readonly connectionParticipants = new Map<
    string,
    Participant<ParticipantMetadata>
  >();
  private readonly participantConnections = new Map<string, string>();
  private readonly watcherConnections = new Set<string>();
  private connectionId: string | null = null;
  private status: SessionStatus;
  private phase: GamePhase = 'lobby';
  private state: State | null;
  private revision = 0;
  private self: Participant<ParticipantMetadata> | null;
  private participants: Participant<ParticipantMetadata>[];
  private lobbyMetadata: LobbyMetadata | undefined;
  private error: string | null = null;

  private constructor(
    private readonly owner: SessionOwner<ParticipantMetadata, LobbyMetadata>,
    private readonly transport: SessionTransport,
    readonly role: SessionRole,
    private readonly hostOptions?: CreateGameOptions<
      State,
      GameEvent,
      ParticipantMetadata,
      LobbyMetadata
    >
  ) {
    this.state = null;
    this.status = role === 'host' ? 'connected' : 'connecting';
    this.self = hostOptions
      ? createParticipant(hostOptions.participantName, 0, hostOptions.participantMetadata)
      : null;
    this.participants = this.self ? [this.self] : [];
    this.lobbyMetadata = hostOptions
      ? hostOptions.getLobbyMetadata(this.participants)
      : undefined;
  }

  static host<
    State,
    GameEvent,
    ParticipantMetadata extends JsonValue,
    LobbyMetadata extends JsonValue,
  >(
    owner: SessionOwner<ParticipantMetadata, LobbyMetadata>,
    transport: SessionTransport,
    options: CreateGameOptions<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata> {
    return new GameSession(owner, transport, 'host', options);
  }

  static client<
    State,
    GameEvent,
    ParticipantMetadata extends JsonValue,
    LobbyMetadata extends JsonValue,
  >(
    owner: SessionOwner<ParticipantMetadata, LobbyMetadata>,
    transport: SessionTransport
  ): GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata> {
    return new GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata>(
      owner,
      transport,
      'client'
    );
  }

  get snapshot(): SessionSnapshot<State, ParticipantMetadata, LobbyMetadata> {
    return {
      role: this.role,
      status: this.status,
      phase: this.phase,
      state: this.state,
      revision: this.revision,
      self: this.self,
      participants: [...this.participants],
      lobbyMetadata: this.lobbyMetadata ?? null,
      error: this.error,
    };
  }

  subscribe(
    listener: SessionListener<State, ParticipantMetadata, LobbyMetadata>
  ): () => void {
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
    if (!this.hostOptions) throw new Error('The host configuration is not available');
    const rejection = this.hostOptions.validateStart?.([...this.participants]);
    if (rejection) throw new Error(rejection);
    this.state = this.hostOptions.createInitialState([...this.participants]);
    this.phase = 'started';
    this.emit();
    await Promise.all([
      this.broadcast({
        v: PROTOCOL_VERSION,
        kind: 'gameStarted',
        state: this.state,
        revision: this.revision,
      }),
      this.closeWatchers(),
    ]);
  }

  async leaveGame(): Promise<void> {
    if (this.status === 'left') return;
    const wasDisconnected = this.status === 'disconnected';
    this.status = 'left';
    this.emit();
    try {
      if (this.role === 'host') {
        this.watcherConnections.clear();
        await this.transport.stopServerAsync();
      } else if (this.connectionId && !wasDisconnected) {
        try {
          await this.sendToServer({ v: PROTOCOL_VERSION, kind: 'leave' });
        } finally {
          await this.transport.disconnectAsync(this.connectionId);
        }
      }
    } finally {
      this.owner.sessionEnded(
        this as unknown as GameSession<
          unknown,
          unknown,
          ParticipantMetadata,
          LobbyMetadata
        >
      );
    }
  }

  attachIncoming(connectionId: string): void {
    if (this.role !== 'host') return;
    this.decoders.set(connectionId, new MessageDecoder());
  }

  async attachServer(
    connectionId: string,
    participantName: string,
    participantMetadata: ParticipantMetadata
  ): Promise<void> {
    this.connectionId = connectionId;
    this.decoders.set(connectionId, new MessageDecoder());
    await this.sendToServer({
      v: PROTOCOL_VERSION,
      kind: 'join',
      participantName: cleanName(participantName),
      participantMetadata,
    });
  }

  receive(connectionId: string, data: Uint8Array): void {
    const decoder = this.decoders.get(connectionId);
    if (!decoder) return;
    try {
      for (const message of decoder.push(data)) {
        void this.handleMessage(connectionId, message).catch((cause) => {
          if (this.status === 'left') return;
          this.fail(cause instanceof Error ? cause.message : 'Could not handle LAN message');
          void this.transport.disconnectAsync(connectionId).catch(() => undefined);
        });
      }
    } catch (cause) {
      this.fail(cause instanceof Error ? cause.message : 'Invalid LAN message');
      void this.transport.disconnectAsync(connectionId).catch(() => undefined);
    }
  }

  disconnected(connectionId: string): void {
    this.decoders.delete(connectionId);
    if (this.role === 'client' && connectionId === this.connectionId && this.status !== 'left') {
      this.status = 'disconnected';
      this.error = 'The host disconnected';
      this.participants = this.self ? [this.self] : [];
      this.emit();
      return;
    }
    if (this.role === 'host') {
      if (this.watcherConnections.delete(connectionId)) return;
      if (this.status === 'left') {
        this.forgetParticipant(connectionId);
        return;
      }
      void this.removeParticipant(connectionId).catch(() => undefined);
    }
  }

  fail(message: string): void {
    this.error = message;
    this.emit();
  }

  private async handleMessage(
    connectionId: string,
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): Promise<void> {
    if (this.role === 'host') {
      await this.handleHostMessage(connectionId, message);
    } else {
      this.handleClientMessage(message);
    }
  }

  private async handleHostMessage(
    connectionId: string,
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): Promise<void> {
    if (message.kind === 'watch') {
      await this.acceptWatcher(connectionId);
      return;
    }
    if (message.kind === 'join') {
      await this.acceptParticipant(
        connectionId,
        message.participantName,
        message.participantMetadata
      );
      return;
    }
    const participant = this.connectionParticipants.get(connectionId);
    if (!participant) return;
    if (message.kind === 'gameEvent') await this.applyEvent(message.event, participant);
    if (message.kind === 'leave') {
      await this.removeParticipant(connectionId);
      await this.transport.disconnectAsync(connectionId).catch(() => undefined);
    }
  }

  private handleClientMessage(
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): void {
    if (message.kind === 'welcome') {
      this.self = message.self;
      this.participants = message.participants;
      this.state = message.state;
      this.revision = message.revision;
      this.phase = message.phase;
      this.lobbyMetadata = message.lobbyMetadata;
      this.status = 'connected';
      this.emit();
    } else if (message.kind === 'participantJoined') {
      this.participants = [
        ...this.participants.filter(
          (participant) => participant.id !== message.participant.id
        ),
        message.participant,
      ];
      this.lobbyMetadata = message.lobbyMetadata;
      this.emit();
    } else if (message.kind === 'participantLeft') {
      this.participants = this.participants.filter(
        (participant) => participant.id !== message.participantId
      );
      this.lobbyMetadata = message.lobbyMetadata;
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

  private async acceptParticipant(
    connectionId: string,
    participantName: string,
    participantMetadata: ParticipantMetadata
  ): Promise<void> {
    if (this.connectionParticipants.has(connectionId)) return;
    if (!this.hostOptions) throw new Error('The host configuration is not available');
    if (this.phase === 'started') {
      await this.send(connectionId, { v: PROTOCOL_VERSION, kind: 'rejected', reason: 'The game has already started' });
      await this.transport.disconnectAsync(connectionId);
      return;
    }
    const usedSlots = new Set(this.participants.map((participant) => participant.slot));
    let slot = 1;
    while (usedSlots.has(slot)) slot += 1;
    const participant = createParticipant(
      cleanName(participantName),
      slot,
      participantMetadata
    );
    const rejection = this.hostOptions.validateJoin?.(
      participant,
      [...this.participants]
    );
    if (rejection) {
      await this.send(connectionId, {
        v: PROTOCOL_VERSION,
        kind: 'rejected',
        reason: rejection,
      });
      await this.transport.disconnectAsync(connectionId);
      return;
    }

    this.connectionParticipants.set(connectionId, participant);
    this.participantConnections.set(participant.id, connectionId);
    this.participants = [...this.participants, participant];
    this.lobbyMetadata = this.hostOptions.getLobbyMetadata(this.participants);
    await this.send(connectionId, {
      v: PROTOCOL_VERSION,
      kind: 'welcome',
      self: participant,
      participants: this.participants,
      state: this.state,
      revision: this.revision,
      phase: this.phase,
      lobbyMetadata: this.requireLobbyMetadata(),
    });
    await Promise.all([
      this.broadcast(
        {
          v: PROTOCOL_VERSION,
          kind: 'participantJoined',
          participant,
          lobbyMetadata: this.requireLobbyMetadata(),
        },
        connectionId
      ),
      this.notifyWatchers(),
    ]);
    this.emit();
  }

  private async removeParticipant(connectionId: string): Promise<void> {
    const participant = this.forgetParticipant(connectionId);
    if (!participant) return;
    if (this.status === 'left') return;
    if (!this.hostOptions) return;
    this.lobbyMetadata = this.hostOptions.getLobbyMetadata(this.participants);
    await Promise.all([
      this.broadcastBestEffort({
        v: PROTOCOL_VERSION,
        kind: 'participantLeft',
        participantId: participant.id,
        lobbyMetadata: this.requireLobbyMetadata(),
      }),
      this.notifyWatchers(),
    ]);
    this.emit();
  }

  private forgetParticipant(
    connectionId: string
  ): Participant<ParticipantMetadata> | undefined {
    const participant = this.connectionParticipants.get(connectionId);
    if (!participant) return undefined;
    this.connectionParticipants.delete(connectionId);
    this.participantConnections.delete(participant.id);
    this.participants = this.participants.filter(
      (candidate) => candidate.id !== participant.id
    );
    return participant;
  }

  private async acceptWatcher(connectionId: string): Promise<void> {
    if (this.watcherConnections.has(connectionId)) return;
    this.watcherConnections.add(connectionId);
    try {
      await this.send(connectionId, {
        v: PROTOCOL_VERSION,
        kind: 'watching',
        phase: this.phase,
        lobbyMetadata: this.requireLobbyMetadata(),
      });
      if (this.phase !== 'lobby' || this.status !== 'connected') {
        this.watcherConnections.delete(connectionId);
        await this.transport.disconnectAsync(connectionId);
      }
    } catch (error) {
      this.watcherConnections.delete(connectionId);
      throw error;
    }
  }

  private async closeWatchers(): Promise<void> {
    const connectionIds = [...this.watcherConnections];
    this.watcherConnections.clear();
    await Promise.allSettled(
      connectionIds.map((connectionId) => this.transport.disconnectAsync(connectionId))
    );
  }

  private async notifyWatchers(): Promise<void> {
    const message: WireMessage<
      State,
      GameEvent,
      ParticipantMetadata,
      LobbyMetadata
    > = {
      v: PROTOCOL_VERSION,
      kind: 'watching',
      phase: this.phase,
      lobbyMetadata: this.requireLobbyMetadata(),
    };
    await Promise.allSettled(
      [...this.watcherConnections].map((connectionId) => this.send(connectionId, message))
    );
  }

  private requireLobbyMetadata(): LobbyMetadata {
    if (this.lobbyMetadata === undefined) throw new Error('Lobby metadata is not available');
    return this.lobbyMetadata;
  }

  private async applyEvent(
    event: GameEvent,
    participant: Participant<ParticipantMetadata>
  ): Promise<void> {
    if (!this.hostOptions || this.state === null) return;
    this.state = this.hostOptions.reduceEvent(this.state, event, participant);
    this.revision += 1;
    await this.broadcast({ v: PROTOCOL_VERSION, kind: 'state', state: this.state, revision: this.revision });
    this.emit();
  }

  private async sendToServer(
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): Promise<void> {
    if (!this.connectionId) throw new Error('The server connection is not ready');
    await this.send(this.connectionId, message);
  }

  private async send(
    connectionId: string,
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): Promise<void> {
    await this.transport.sendAsync(connectionId, encodeMessage(message));
  }

  private async broadcast(
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>,
    excludedConnectionId?: string
  ): Promise<void> {
    const data = encodeMessage(message);
    const sends = [...this.participantConnections.values()]
      .filter((connectionId) => connectionId !== excludedConnectionId)
      .map((connectionId) => this.transport.sendAsync(connectionId, data));
    await Promise.all(sends);
  }

  private async broadcastBestEffort(
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): Promise<void> {
    const data = encodeMessage(message);
    await Promise.allSettled(
      [...this.participantConnections.values()].map((connectionId) =>
        this.transport.sendAsync(connectionId, data)
      )
    );
  }

  private emit(): void {
    const snapshot = this.snapshot;
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

function createParticipant<Metadata extends JsonValue>(
  name: string,
  slot: number,
  metadata: Metadata
): Participant<Metadata> {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    name: cleanName(name),
    slot,
    metadata,
  };
}

function cleanName(name: string): string {
  return name.trim().slice(0, 24) || 'Participant';
}
