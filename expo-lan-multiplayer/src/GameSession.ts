import { encodeMessage, MessageDecoder, PROTOCOL_VERSION, type WireMessage } from './protocol';
import type { SessionTransport } from './SessionTransport';
import type {
  CreateGameOptions,
  GamePhase,
  JsonValue,
  Participant,
  SessionListener,
  SessionRecoveryState,
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

type ConnectionRole = 'pending' | 'watcher' | 'participant';
const HEARTBEAT_INTERVAL_MS = 3_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

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
  private readonly connectionRoles = new Map<string, ConnectionRole>();
  private readonly connectionParticipants = new Map<
    string,
    Participant<ParticipantMetadata>
  >();
  private readonly participantConnections = new Map<string, string>();
  private readonly watcherConnections = new Set<string>();
  private readonly resumeTokens = new Map<string, string>();
  private readonly connectedParticipantIds = new Set<string>();
  private readonly connectionLastSeen = new Map<string, number>();
  private readonly handshakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private serverLastSeen = Date.now();
  private ended = false;
  private connectionId: string | null = null;
  private status: SessionStatus;
  private phase: GamePhase = 'lobby';
  private state: State | null = null;
  private revision = 0;
  private self: Participant<ParticipantMetadata> | null;
  private participants: Participant<ParticipantMetadata>[];
  private lobbyMetadata: LobbyMetadata | undefined;
  private error: string | null = null;
  private tableId: string | null = null;
  private sessionName = '';
  private authorityTerm = 0;
  private hostParticipantId: string | null = null;
  private hostOrder: string[] = [];
  private messageQueue: Promise<void> = Promise.resolve();
  private _role: SessionRole;
  private hostOptions?: CreateGameOptions<
    State,
    GameEvent,
    ParticipantMetadata,
    LobbyMetadata
  >;

  private constructor(
    private readonly owner: SessionOwner<ParticipantMetadata, LobbyMetadata>,
    private readonly transport: SessionTransport,
    role: SessionRole,
    hostOptions?: CreateGameOptions<State, GameEvent, ParticipantMetadata, LobbyMetadata>,
    tableId?: string
  ) {
    this._role = role;
    this.hostOptions = hostOptions;
    this.status = role === 'host' ? 'connected' : 'connecting';
    this.self = hostOptions
      ? createParticipant(hostOptions.participantName, 0, hostOptions.participantMetadata)
      : null;
    this.participants = this.self ? [this.self] : [];
    if (this.self && hostOptions) {
      this.sessionName = hostOptions.name;
      this.tableId = tableId ?? randomToken(12);
      this.authorityTerm = 1;
      this.hostParticipantId = this.self.id;
      this.hostOrder = [this.self.id];
      this.resumeTokens.set(this.self.id, randomToken(32));
      this.connectedParticipantIds.add(this.self.id);
      this.lobbyMetadata = hostOptions.getLobbyMetadata(
        this.participants,
        new Set(this.connectedParticipantIds)
      );
    }
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
    const nodeTimer = this.heartbeatTimer as ReturnType<typeof setInterval> & {
      unref?: () => void;
    };
    nodeTimer.unref?.();
  }

  get role(): SessionRole {
    return this._role;
  }

  static host<
    State,
    GameEvent,
    ParticipantMetadata extends JsonValue,
    LobbyMetadata extends JsonValue,
  >(
    owner: SessionOwner<ParticipantMetadata, LobbyMetadata>,
    transport: SessionTransport,
    options: CreateGameOptions<State, GameEvent, ParticipantMetadata, LobbyMetadata>,
    tableId?: string
  ): GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata> {
    return new GameSession(owner, transport, 'host', options, tableId);
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

  static restore<
    State,
    GameEvent,
    ParticipantMetadata extends JsonValue,
    LobbyMetadata extends JsonValue,
  >(
    owner: SessionOwner<ParticipantMetadata, LobbyMetadata>,
    transport: SessionTransport,
    recovery: SessionRecoveryState<State, ParticipantMetadata, LobbyMetadata>,
    selfParticipantId: string
  ): GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata> {
    const session = GameSession.client<State, GameEvent, ParticipantMetadata, LobbyMetadata>(
      owner,
      transport
    );
    session.applyRecovery(recovery);
    session.self = session.participants.find(({ id }) => id === selfParticipantId) ?? null;
    if (!session.self || !session.resumeTokens.has(selfParticipantId)) {
      session.dispose();
      throw new Error('The saved participant is not part of this table');
    }
    session.status = 'disconnected';
    session.connectedParticipantIds.delete(selfParticipantId);
    session.error = 'The saved table needs to reconnect';
    return session;
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
      tableId: this.tableId,
      authorityTerm: this.authorityTerm,
      hostParticipantId: this.hostParticipantId,
      hostOrder: [...this.hostOrder],
      connectedParticipantIds: [...this.connectedParticipantIds],
    };
  }

  exportRecoveryState(): SessionRecoveryState<State, ParticipantMetadata, LobbyMetadata> {
    if (!this.tableId || !this.hostParticipantId || this.lobbyMetadata === undefined) {
      throw new Error('Recovery state is not available before the session is accepted');
    }
    return {
      name: this.sessionName,
      tableId: this.tableId,
      authorityTerm: this.authorityTerm,
      hostParticipantId: this.hostParticipantId,
      hostOrder: [...this.hostOrder],
      resumeTokens: Object.fromEntries(this.resumeTokens),
      participants: [...this.participants],
      connectedParticipantIds: [...this.connectedParticipantIds],
      state: this.state,
      revision: this.revision,
      phase: this.phase,
      lobbyMetadata: this.lobbyMetadata,
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
    if (this.status !== 'connected' || !this.self) {
      throw new Error('The game session is not connected');
    }
    if (this.phase !== 'started') throw new Error('The game has not started');
    if (this.role === 'host') {
      await this.applyEvent(event, this.self, true);
      return;
    }
    await this.sendToServer({ v: PROTOCOL_VERSION, kind: 'gameEvent', event });
  }

  async startGame(): Promise<void> {
    if (this.role !== 'host') throw new Error('Only the host can start the game');
    if (this.status !== 'connected') throw new Error('The game session is not connected');
    if (this.phase === 'started') return;
    const options = this.requireHostOptions();
    const connected = new Set(this.connectedParticipantIds);
    const rejection = options.validateStart?.([...this.participants], connected);
    if (rejection) throw new Error(rejection);
    this.state = options.createInitialState([...this.participants]);
    this.phase = 'started';
    this.emit();
    await Promise.all([this.broadcastSync(), this.closeWatchers()]);
  }

  async refreshLobbyMetadata(): Promise<void> {
    if (this.role !== 'host') throw new Error('Only the host can refresh lobby metadata');
    if (this.status !== 'connected') throw new Error('The game session is not connected');
    if (this.phase !== 'lobby') throw new Error('The game has already started');
    this.recomputeLobbyMetadata();
    this.emit();
    await Promise.all([this.broadcastSync(), this.notifyWatchers()]);
  }

  async returnToLobby(): Promise<void> {
    if (this.role !== 'host') throw new Error('Only the host can return to the lobby');
    if (this.status !== 'connected') throw new Error('The game session is not connected');
    if (this.phase === 'lobby') return;
    this.state = null;
    this.phase = 'lobby';
    this.recomputeLobbyMetadata();
    this.emit();
    await Promise.all([this.broadcastSync(), this.notifyWatchers()]);
  }

  async removeDisconnectedParticipant(participantId: string): Promise<void> {
    if (this.role !== 'host') throw new Error('Only the host can remove a participant');
    if (this.phase !== 'lobby') throw new Error('Players can only be removed from the lobby');
    if (this.connectedParticipantIds.has(participantId)) {
      throw new Error('The participant is still connected');
    }
    const participant = this.participants.find(({ id }) => id === participantId);
    if (!participant || participant.id === this.self?.id) return;
    this.resumeTokens.delete(participant.id);
    this.participants = this.participants.filter(({ id }) => id !== participant.id);
    this.hostOrder = this.hostOrder.filter((id) => id !== participant.id);
    this.recomputeLobbyMetadata();
    await Promise.all([this.broadcastSync(), this.notifyWatchers()]);
    this.emit();
  }

  async leaveGame(): Promise<void> {
    if (this.ended) return;
    const wasConnected = this.status === 'connected';
    if (this.role === 'host' && wasConnected) {
      await this.broadcastBestEffort({ v: PROTOCOL_VERSION, kind: 'tableClosed' });
    }
    this.status = 'left';
    this.emit();
    try {
      if (this.role === 'host') {
        this.watcherConnections.clear();
        await this.transport.stopServerAsync();
      } else if (this.connectionId) {
        try {
          if (wasConnected) {
            await this.sendToServer({ v: PROTOCOL_VERSION, kind: 'leave' });
          }
        } finally {
          await this.transport.disconnectAsync(this.connectionId);
        }
      }
    } finally {
      this.endSession();
    }
  }

  dispose(): void {
    clearInterval(this.heartbeatTimer);
    this.handshakeTimers.forEach(clearTimeout);
    this.handshakeTimers.clear();
  }

  async suspendConnection(): Promise<void> {
    if (this.status === 'left') return;
    this.status = 'disconnected';
    this.error = 'Connection suspended';
    if (this.self) this.connectedParticipantIds.delete(this.self.id);
    this.emit();
    if (this.role === 'host') {
      await this.transport.stopServerAsync();
    } else if (this.connectionId) {
      await this.transport.disconnectAsync(this.connectionId).catch(() => undefined);
    }
  }

  beginPromotion(
    options: CreateGameOptions<State, GameEvent, ParticipantMetadata, LobbyMetadata>,
    highestObservedAuthorityTerm = this.authorityTerm
  ): void {
    if (!this.self || !this.tableId) throw new Error('A participant session is required to host');
    const connectedParticipantIds = new Set([this.self.id]);
    const lobbyMetadata = options.getLobbyMetadata(
      [...this.participants],
      connectedParticipantIds
    );
    this._role = 'host';
    this.hostOptions = options;
    this.authorityTerm = Math.max(this.authorityTerm, highestObservedAuthorityTerm) + 1;
    this.hostParticipantId = this.self.id;
    this.status = 'reconnecting';
    this.error = null;
    this.connectionId = null;
    this.decoders.clear();
    this.connectionRoles.clear();
    this.connectionParticipants.clear();
    this.participantConnections.clear();
    this.connectionLastSeen.clear();
    this.handshakeTimers.forEach(clearTimeout);
    this.handshakeTimers.clear();
    this.watcherConnections.clear();
    this.connectedParticipantIds.clear();
    connectedParticipantIds.forEach((id) => this.connectedParticipantIds.add(id));
    this.lobbyMetadata = lobbyMetadata;
  }

  commitPromotion(): void {
    if (this.role !== 'host' || !this.hostOptions) {
      throw new Error('No host promotion is pending');
    }
    this.status = 'connected';
    this.error = null;
    this.emit();
  }

  abortPromotion(previousHostParticipantId: string, previousAuthorityTerm: number): void {
    this._role = 'client';
    this.hostOptions = undefined;
    this.hostParticipantId = previousHostParticipantId;
    this.authorityTerm = previousAuthorityTerm;
    this.status = 'disconnected';
    this.error = 'Could not start the replacement host';
    this.connectedParticipantIds.clear();
    this.emit();
  }

  demoteToClient(): void {
    if (!this.self) throw new Error('A participant session is required to reconnect');
    this._role = 'client';
    this.hostOptions = undefined;
    this.status = 'reconnecting';
    this.error = null;
    this.connectionId = null;
    this.decoders.clear();
    this.connectionRoles.clear();
    this.connectionParticipants.clear();
    this.participantConnections.clear();
    this.connectionLastSeen.clear();
    this.handshakeTimers.forEach(clearTimeout);
    this.handshakeTimers.clear();
    this.watcherConnections.clear();
    this.connectedParticipantIds.delete(this.self.id);
    this.emit();
  }

  markReconnecting(): void {
    if (this.status === 'left') return;
    this.status = 'reconnecting';
    this.error = null;
    this.emit();
  }

  attachIncoming(connectionId: string): void {
    if (this.role !== 'host') {
      void this.transport.disconnectAsync(connectionId).catch(() => undefined);
      return;
    }
    this.decoders.set(connectionId, new MessageDecoder());
    this.connectionRoles.set(connectionId, 'pending');
    const timeout = setTimeout(() => {
      this.handshakeTimers.delete(connectionId);
      if (this.connectionRoles.get(connectionId) === 'pending') {
        void this.transport.disconnectAsync(connectionId).catch(() => undefined);
      }
    }, HANDSHAKE_TIMEOUT_MS);
    const nodeTimer = timeout as ReturnType<typeof setTimeout> & { unref?: () => void };
    nodeTimer.unref?.();
    this.handshakeTimers.set(connectionId, timeout);
  }

  async attachServer(
    connectionId: string,
    participantName: string,
    participantMetadata: ParticipantMetadata
  ): Promise<void> {
    this.connectionId = connectionId;
    this.serverLastSeen = Date.now();
    this.decoders.set(connectionId, new MessageDecoder());
    await this.sendToServer({
      v: PROTOCOL_VERSION,
      kind: 'join',
      participantName: cleanName(participantName),
      participantMetadata,
    });
  }

  async attachResumedServer(connectionId: string): Promise<void> {
    if (!this.self || !this.tableId) throw new Error('No saved participant identity is available');
    const resumeToken = this.resumeTokens.get(this.self.id);
    if (!resumeToken) throw new Error('No resume token is available');
    this.connectionId = connectionId;
    this.status = 'reconnecting';
    this.serverLastSeen = Date.now();
    this.decoders.set(connectionId, new MessageDecoder());
    this.emit();
    await this.sendToServer({
      v: PROTOCOL_VERSION,
      kind: 'resume',
      tableId: this.tableId,
      participantId: this.self.id,
      resumeToken,
    });
  }

  receive(connectionId: string, data: Uint8Array): void {
    if (this.role === 'client' && this.connectionId !== connectionId) return;
    if (this.role === 'host') this.connectionLastSeen.set(connectionId, Date.now());
    else this.serverLastSeen = Date.now();
    const decoder = this.decoders.get(connectionId);
    if (!decoder) return;
    try {
      for (const message of decoder.push(data)) {
        if (
          this.role === 'host' &&
          this.connectionRoles.get(connectionId) === 'pending' &&
          (message.kind === 'join' || message.kind === 'resume' || message.kind === 'watch')
        ) {
          const handshakeTimer = this.handshakeTimers.get(connectionId);
          if (handshakeTimer) clearTimeout(handshakeTimer);
          this.handshakeTimers.delete(connectionId);
        }
        this.messageQueue = this.messageQueue
          .then(() => this.handleMessage(connectionId, message))
          .catch((cause) => {
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
    this.messageQueue = this.messageQueue
      .then(() => this.handleDisconnected(connectionId))
      .catch(() => undefined);
  }

  private handleDisconnected(connectionId: string): void {
    this.decoders.delete(connectionId);
    this.connectionRoles.delete(connectionId);
    this.connectionLastSeen.delete(connectionId);
    const handshakeTimer = this.handshakeTimers.get(connectionId);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    this.handshakeTimers.delete(connectionId);
    if (this.role === 'client' && connectionId === this.connectionId && this.status !== 'left') {
      this.connectionId = null;
      this.status = 'disconnected';
      this.error = 'The host disconnected';
      if (this.self) this.connectedParticipantIds.delete(this.self.id);
      if (this.hostParticipantId) this.connectedParticipantIds.delete(this.hostParticipantId);
      this.emit();
      return;
    }
    if (this.role !== 'host') return;
    if (this.watcherConnections.delete(connectionId)) return;
    const participant = this.connectionParticipants.get(connectionId);
    this.connectionParticipants.delete(connectionId);
    if (!participant) return;
    if (this.participantConnections.get(participant.id) !== connectionId) return;
    this.participantConnections.delete(participant.id);
    this.connectedParticipantIds.delete(participant.id);
    this.recomputeLobbyMetadata();
    this.emit();
    void Promise.all([this.broadcastSync(), this.notifyWatchers()]).catch(() => undefined);
  }

  fail(message: string): void {
    this.error = message;
    this.emit();
  }

  authorityLost(message: string): void {
    if (this.role !== 'host' || this.status === 'left') {
      this.fail(message);
      return;
    }
    this.status = 'disconnected';
    this.error = message;
    if (this.self) this.connectedParticipantIds.delete(this.self.id);
    this.emit();
  }

  private async handleMessage(
    connectionId: string,
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): Promise<void> {
    if (this.role === 'host') {
      await this.handleHostMessage(connectionId, message);
    } else if (connectionId === this.connectionId) {
      this.handleClientMessage(message);
    }
  }

  private async handleHostMessage(
    connectionId: string,
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): Promise<void> {
    const role = this.connectionRoles.get(connectionId);
    if (role === 'pending') {
      if (message.kind === 'watch') {
        await this.acceptWatcher(connectionId);
      } else if (message.kind === 'join') {
        await this.acceptParticipant(
          connectionId,
          message.participantName,
          message.participantMetadata
        );
      } else if (message.kind === 'resume') {
        await this.acceptResume(
          connectionId,
          message.tableId,
          message.participantId,
          message.resumeToken
        );
      } else {
        await this.transport.disconnectAsync(connectionId);
      }
      return;
    }
    if (role !== 'participant') return;
    const participant = this.connectionParticipants.get(connectionId);
    if (!participant || this.participantConnections.get(participant.id) !== connectionId) return;
    if (message.kind === 'heartbeat') {
      await this.send(connectionId, {
        v: PROTOCOL_VERSION,
        kind: 'heartbeatAck',
        sentAt: message.sentAt,
      });
      return;
    }
    if (message.kind === 'heartbeatAck') return;
    if (message.kind === 'gameEvent') await this.applyEvent(message.event, participant, false);
    if (message.kind === 'leave') {
      await this.removeParticipant(connectionId);
      await this.transport.disconnectAsync(connectionId).catch(() => undefined);
    }
  }

  private handleClientMessage(
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): void {
    if (message.kind === 'heartbeat') {
      if (this.connectionId) {
        void this.send(this.connectionId, {
          v: PROTOCOL_VERSION,
          kind: 'heartbeatAck',
          sentAt: message.sentAt,
        }).catch(() => undefined);
      }
    } else if (message.kind === 'heartbeatAck') {
      return;
    } else if (message.kind === 'welcome') {
      this.self = message.self;
      this.applyRecovery(message.recovery);
      this.status = 'connected';
      this.error = null;
      this.emit();
    } else if (message.kind === 'sync') {
      if (message.recovery.authorityTerm < this.authorityTerm) return;
      this.applyRecovery(message.recovery);
      this.emit();
    } else if (message.kind === 'participantJoined') {
      this.participants = [
        ...this.participants.filter(({ id }) => id !== message.participant.id),
        message.participant,
      ];
      this.lobbyMetadata = message.lobbyMetadata;
      this.emit();
    } else if (message.kind === 'participantLeft') {
      this.participants = this.participants.filter(({ id }) => id !== message.participantId);
      this.connectedParticipantIds.delete(message.participantId);
      this.lobbyMetadata = message.lobbyMetadata;
      this.emit();
    } else if (message.kind === 'participantDisconnected') {
      this.connectedParticipantIds.delete(message.participantId);
      this.emit();
    } else if (message.kind === 'participantReconnected') {
      this.connectedParticipantIds.add(message.participantId);
      this.emit();
    } else if (message.kind === 'lobbyUpdated') {
      this.lobbyMetadata = message.lobbyMetadata;
      this.emit();
    } else if (message.kind === 'returnedToLobby') {
      this.state = null;
      this.phase = 'lobby';
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
      if (message.terminal) {
        this.status = 'left';
        this.error = message.reason;
        this.emit();
        const connectionId = this.connectionId;
        if (connectionId) {
          void this.transport.disconnectAsync(connectionId).catch(() => undefined);
        }
        this.endSession();
      } else {
        this.status = 'disconnected';
        this.fail(message.reason);
      }
    } else if (message.kind === 'tableClosed') {
      this.status = 'left';
      this.error = 'The host closed the table';
      this.emit();
      this.endSession();
    }
  }

  private async acceptParticipant(
    connectionId: string,
    participantName: string,
    participantMetadata: ParticipantMetadata
  ): Promise<void> {
    const options = this.requireHostOptions();
    if (this.phase === 'started') {
      await this.reject(connectionId, 'The game has already started');
      return;
    }
    const usedSlots = new Set(this.participants.map(({ slot }) => slot));
    let slot = 1;
    while (usedSlots.has(slot)) slot += 1;
    const participant = createParticipant(cleanName(participantName), slot, participantMetadata);
    const rejection = options.validateJoin?.(participant, [...this.participants]);
    if (rejection) {
      await this.reject(connectionId, rejection);
      return;
    }
    const previousLobbyMetadata = this.lobbyMetadata;
    this.participants = [...this.participants, participant];
    this.hostOrder = [...this.hostOrder, participant.id];
    this.resumeTokens.set(participant.id, randomToken(32));
    this.bindParticipant(connectionId, participant);
    try {
      this.recomputeLobbyMetadata();
      await this.sendWelcome(connectionId, participant);
    } catch (error) {
      this.connectionParticipants.delete(connectionId);
      this.participantConnections.delete(participant.id);
      this.connectionRoles.delete(connectionId);
      this.connectionLastSeen.delete(connectionId);
      this.connectedParticipantIds.delete(participant.id);
      this.resumeTokens.delete(participant.id);
      this.participants = this.participants.filter(({ id }) => id !== participant.id);
      this.hostOrder = this.hostOrder.filter((id) => id !== participant.id);
      this.lobbyMetadata = previousLobbyMetadata;
      throw error;
    }
    await Promise.all([
      this.broadcastSync(connectionId),
      this.notifyWatchers(),
    ]);
    this.emit();
  }

  private async acceptResume(
    connectionId: string,
    tableId: string,
    participantId: string,
    resumeToken: string
  ): Promise<void> {
    if (
      tableId !== this.tableId ||
      this.resumeTokens.get(participantId) !== resumeToken ||
      resumeToken.length < 16
    ) {
      await this.reject(connectionId, 'The saved table identity is not valid', true);
      return;
    }
    const participant = this.participants.find(({ id }) => id === participantId);
    if (!participant) {
      await this.reject(connectionId, 'The participant is no longer part of this table', true);
      return;
    }
    const previousConnection = this.participantConnections.get(participantId);
    const wasConnected = this.connectedParticipantIds.has(participantId);
    const previousLobbyMetadata = this.lobbyMetadata;
    this.bindParticipant(connectionId, participant);
    try {
      this.recomputeLobbyMetadata();
      await this.sendWelcome(connectionId, participant);
    } catch (error) {
      this.connectionParticipants.delete(connectionId);
      this.connectionRoles.delete(connectionId);
      this.connectionLastSeen.delete(connectionId);
      if (previousConnection) this.participantConnections.set(participantId, previousConnection);
      else this.participantConnections.delete(participantId);
      if (!wasConnected) this.connectedParticipantIds.delete(participantId);
      this.lobbyMetadata = previousLobbyMetadata;
      throw error;
    }
    await Promise.all([this.broadcastSync(connectionId), this.notifyWatchers()]);
    this.emit();
    if (previousConnection && previousConnection !== connectionId) {
      await this.transport.disconnectAsync(previousConnection).catch(() => undefined);
    }
  }

  private bindParticipant(
    connectionId: string,
    participant: Participant<ParticipantMetadata>
  ): void {
    const handshakeTimer = this.handshakeTimers.get(connectionId);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    this.handshakeTimers.delete(connectionId);
    this.connectionRoles.set(connectionId, 'participant');
    this.connectionParticipants.set(connectionId, participant);
    this.participantConnections.set(participant.id, connectionId);
    this.connectedParticipantIds.add(participant.id);
    this.connectionLastSeen.set(connectionId, Date.now());
  }

  private async removeParticipant(connectionId: string): Promise<void> {
    const participant = this.connectionParticipants.get(connectionId);
    if (!participant || this.participantConnections.get(participant.id) !== connectionId) return;
    this.connectionParticipants.delete(connectionId);
    this.participantConnections.delete(participant.id);
    this.connectionRoles.delete(connectionId);
    this.connectedParticipantIds.delete(participant.id);
    this.resumeTokens.delete(participant.id);
    this.participants = this.participants.filter(({ id }) => id !== participant.id);
    this.hostOrder = this.hostOrder.filter((id) => id !== participant.id);
    this.recomputeLobbyMetadata();
    await Promise.all([this.broadcastSync(), this.notifyWatchers()]);
    this.emit();
  }

  private async acceptWatcher(connectionId: string): Promise<void> {
    const handshakeTimer = this.handshakeTimers.get(connectionId);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    this.handshakeTimers.delete(connectionId);
    this.connectionRoles.set(connectionId, 'watcher');
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

  private async reject(
    connectionId: string,
    reason: string,
    terminal = false
  ): Promise<void> {
    await this.send(connectionId, { v: PROTOCOL_VERSION, kind: 'rejected', reason, terminal });
    await this.transport.disconnectAsync(connectionId);
  }

  private async sendWelcome(
    connectionId: string,
    participant: Participant<ParticipantMetadata>
  ): Promise<void> {
    await this.send(connectionId, {
      v: PROTOCOL_VERSION,
      kind: 'welcome',
      self: participant,
      recovery: this.exportRecoveryState(),
    });
  }

  private applyRecovery(
    recovery: SessionRecoveryState<State, ParticipantMetadata, LobbyMetadata>
  ): void {
    this.tableId = recovery.tableId;
    this.sessionName = recovery.name;
    this.authorityTerm = recovery.authorityTerm;
    this.hostParticipantId = recovery.hostParticipantId;
    this.hostOrder = [...recovery.hostOrder];
    this.resumeTokens.clear();
    Object.entries(recovery.resumeTokens).forEach(([id, token]) => {
      this.resumeTokens.set(id, token);
    });
    this.participants = [...recovery.participants];
    this.connectedParticipantIds.clear();
    recovery.connectedParticipantIds.forEach((id) => this.connectedParticipantIds.add(id));
    this.state = recovery.state;
    this.revision = recovery.revision;
    this.phase = recovery.phase;
    this.lobbyMetadata = recovery.lobbyMetadata;
  }

  private recomputeLobbyMetadata(): void {
    const options = this.requireHostOptions();
    this.lobbyMetadata = options.getLobbyMetadata(
      [...this.participants],
      new Set(this.connectedParticipantIds)
    );
  }

  private requireHostOptions(): CreateGameOptions<
    State,
    GameEvent,
    ParticipantMetadata,
    LobbyMetadata
  > {
    if (!this.hostOptions) throw new Error('The host configuration is not available');
    return this.hostOptions;
  }

  private requireLobbyMetadata(): LobbyMetadata {
    if (this.lobbyMetadata === undefined) throw new Error('Lobby metadata is not available');
    return this.lobbyMetadata;
  }

  private async applyEvent(
    event: GameEvent,
    participant: Participant<ParticipantMetadata>,
    authoritativeHost: boolean
  ): Promise<void> {
    const options = this.requireHostOptions();
    if (this.state === null) return;
    this.state = options.reduceEvent(this.state, event, participant, { authoritativeHost });
    this.revision += 1;
    this.recomputeLobbyMetadata();
    this.emit();
    await this.broadcastSync();
  }

  private async closeWatchers(): Promise<void> {
    const connectionIds = [...this.watcherConnections];
    this.watcherConnections.clear();
    connectionIds.forEach((id) => this.connectionRoles.delete(id));
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

  private async broadcastSync(excludedConnectionId?: string): Promise<void> {
    const message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata> = {
      v: PROTOCOL_VERSION,
      kind: 'sync',
      recovery: this.exportRecoveryState(),
    };
    await this.broadcastBestEffort(message, excludedConnectionId);
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

  private async broadcastBestEffort(
    message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>,
    excludedConnectionId?: string
  ): Promise<void> {
    const data = encodeMessage(message);
    await Promise.allSettled(
      [...this.participantConnections.values()]
        .filter((connectionId) => connectionId !== excludedConnectionId)
        .map((connectionId) => this.transport.sendAsync(connectionId, data))
    );
  }

  private emit(): void {
    const snapshot = this.snapshot;
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private endSession(): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.heartbeatTimer);
    this.handshakeTimers.forEach(clearTimeout);
    this.handshakeTimers.clear();
    this.owner.sessionEnded(
      this as unknown as GameSession<
        unknown,
        unknown,
        ParticipantMetadata,
        LobbyMetadata
      >
    );
  }

  private heartbeatTick(): void {
    if (this.status !== 'connected') return;
    const now = Date.now();
    if (this.role === 'client') {
      const connectionId = this.connectionId;
      if (!connectionId) return;
      if (now - this.serverLastSeen > HEARTBEAT_TIMEOUT_MS) {
        void this.transport.disconnectAsync(connectionId).catch(() => undefined);
        return;
      }
      void this.send(connectionId, {
        v: PROTOCOL_VERSION,
        kind: 'heartbeat',
        sentAt: now,
      }).catch(() => this.transport.disconnectAsync(connectionId).catch(() => undefined));
      return;
    }

    for (const connectionId of this.participantConnections.values()) {
      const lastSeen = this.connectionLastSeen.get(connectionId) ?? now;
      if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
        void this.transport.disconnectAsync(connectionId).catch(() => undefined);
        continue;
      }
      void this.send(connectionId, {
        v: PROTOCOL_VERSION,
        kind: 'heartbeat',
        sentAt: now,
      }).catch(() => this.transport.disconnectAsync(connectionId).catch(() => undefined));
    }
  }
}

function createParticipant<Metadata extends JsonValue>(
  name: string,
  slot: number,
  metadata: Metadata
): Participant<Metadata> {
  return {
    id: `${Date.now().toString(36)}-${randomToken(12)}`,
    name: cleanName(name),
    slot,
    metadata,
  };
}

function randomToken(length: number): string {
  let value = '';
  while (value.length < length) {
    value += Math.random().toString(36).slice(2);
  }
  return value.slice(0, length);
}

function cleanName(name: string): string {
  return name.trim().slice(0, 24) || 'Participant';
}
