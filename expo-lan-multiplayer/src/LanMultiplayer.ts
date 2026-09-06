import ExpoLanSockets, {
  type ConnectionClosedEvent,
  type DiscoveredService,
  type LanSocketsErrorEvent,
  type MessageEvent,
} from '@opengamesonline/expo-lan-sockets';

import { GameSession } from './GameSession';
import {
  encodeMessage,
  MessageDecoder,
  PROTOCOL_VERSION,
  SERVICE_TYPE,
  WATCH_ACK_TIMEOUT_MS,
} from './protocol';
import type {
  CreateGameOptions,
  DiscoveredGame,
  GamesListener,
  JoinGameOptions,
  JsonValue,
  RecoverGameOptions,
} from './types';

type Subscription = { remove(): void };
type GameWatch<
  ParticipantMetadata extends JsonValue,
  LobbyMetadata extends JsonValue,
> = {
  connectionId: string;
  decoder: MessageDecoder<unknown, unknown, ParticipantMetadata, LobbyMetadata>;
  timeout: ReturnType<typeof setTimeout>;
};

const SERVICE_ID_LENGTH = 6;
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 500;
const RECOVERY_POLL_MS = 250;
const RECOVERY_BASE_DELAY_MS = 5_000;
const RECOVERY_CANDIDATE_DELAY_MS = 3_000;
const RECOVERY_TIMEOUT_MS = 45_000;

type AdvertisedGame = {
  name: string;
  tableId: string;
  authorityTerm: number;
  hostRank: number;
};

export class LanMultiplayer<
  ParticipantMetadata extends JsonValue = JsonValue,
  LobbyMetadata extends JsonValue = JsonValue,
> {
  private readonly games = new Map<string, DiscoveredService>();
  private readonly gameLobbyMetadata = new Map<string, LobbyMetadata>();
  private readonly serviceHosts = new Map<string, string>();
  private readonly serviceAuthorities = new Map<string, AdvertisedGame>();
  private readonly strongestObservedAuthorities = new Map<string, AdvertisedGame>();
  private readonly gamesListeners = new Set<GamesListener<LobbyMetadata>>();
  private readonly gameWatches = new Map<
    string,
    GameWatch<ParticipantMetadata, LobbyMetadata>
  >();
  private readonly watchConnections = new Map<string, string>();
  private readonly pendingWatches = new Set<string>();
  private readonly subscriptions: Subscription[];
  private activeSession: GameSession<
    unknown,
    unknown,
    ParticipantMetadata,
    LobbyMetadata
  > | null = null;
  private pendingJoinSession: GameSession<
    unknown,
    unknown,
    ParticipantMetadata,
    LobbyMetadata
  > | null = null;
  private joinAttempt = 0;
  private recoveryAttempt = 0;
  private discovering = false;
  private stoppingDiscovery: Promise<void> | null = null;
  private watchGeneration = 0;

  constructor() {
    this.subscriptions = [
      ExpoLanSockets.addListener('onServiceFound', (service) => {
        const advertised = parseAdvertisedName(service.name);
        let game: DiscoveredService;
        let removedVisibleGame = false;
        if (advertised) {
          const strongestObserved = this.strongestObservedAuthorities.get(advertised.tableId);
          if (!strongestObserved || outranks(advertised, strongestObserved)) {
            this.strongestObservedAuthorities.set(advertised.tableId, advertised);
          }
          const superseded = [...this.serviceAuthorities.entries()].some(
            ([serviceId, authority]) =>
              authority.tableId === advertised.tableId &&
              (authority.authorityTerm > advertised.authorityTerm ||
                (authority.authorityTerm === advertised.authorityTerm &&
                  authority.hostRank < advertised.hostRank)) &&
              serviceId !== service.serviceId
          );
          if (superseded) return;
          for (const [serviceId, authority] of this.serviceAuthorities) {
            if (
              authority.tableId === advertised.tableId &&
              (authority.authorityTerm < advertised.authorityTerm ||
                (authority.authorityTerm === advertised.authorityTerm &&
                  authority.hostRank >= advertised.hostRank)) &&
              serviceId !== service.serviceId
            ) {
              removedVisibleGame = this.removeGame(serviceId) || removedVisibleGame;
            }
          }
          this.serviceHosts.set(service.serviceId, advertised.tableId);
          this.serviceAuthorities.set(service.serviceId, advertised);
          game = { ...service, name: advertised.name };
        } else {
          game = service;
        }
        this.games.set(service.serviceId, game);
        if (removedVisibleGame) this.emitGames();
        if (this.discovering) void this.startWatchingGame(service);
      }),
      ExpoLanSockets.addListener('onServiceLost', ({ serviceId }) => {
        if (this.removeGame(serviceId)) this.emitGames();
      }),
      ExpoLanSockets.addListener('onConnectionOpened', (connection) => {
        if (connection.incoming) this.activeSession?.attachIncoming(connection.connectionId);
      }),
      ExpoLanSockets.addListener('onMessage', (event: MessageEvent) => {
        if (this.receiveWatchMessage(event)) return;
        this.activeSession?.receive(event.connectionId, event.data);
      }),
      ExpoLanSockets.addListener('onConnectionClosed', (event: ConnectionClosedEvent) => {
        if (this.watchClosed(event.connectionId)) return;
        this.activeSession?.disconnected(event.connectionId);
      }),
      ExpoLanSockets.addListener('onError', (event: LanSocketsErrorEvent) => {
        if (event.operation === 'discovery') {
          this.discovering = false;
          this.watchGeneration += 1;
          this.recoveryAttempt += 1;
          this.games.clear();
          this.gameLobbyMetadata.clear();
          this.serviceHosts.clear();
          this.serviceAuthorities.clear();
          this.emitGames();
          void this.stopAllWatches();
          this.activeSession?.fail(event.message);
        } else if (event.operation === 'server' && this.activeSession?.role === 'host') {
          this.activeSession.authorityLost(event.message);
        } else {
          this.activeSession?.fail(event.message);
        }
      }),
    ];
  }

  get capabilities() {
    return ExpoLanSockets.capabilities;
  }

  subscribeToGames(listener: GamesListener<LobbyMetadata>): () => void {
    this.gamesListeners.add(listener);
    listener(this.gameList());
    return () => this.gamesListeners.delete(listener);
  }

  async startDiscovery(): Promise<void> {
    if (this.stoppingDiscovery) await this.stoppingDiscovery;
    if (this.discovering) return;
    this.discovering = true;
    try {
      await ExpoLanSockets.startDiscoveryAsync(SERVICE_TYPE);
    } catch (error) {
      this.discovering = false;
      throw error;
    }
  }

  async stopDiscovery(): Promise<void> {
    if (this.stoppingDiscovery) return this.stoppingDiscovery;
    if (!this.discovering) return;
    this.discovering = false;
    this.watchGeneration += 1;
    this.games.clear();
    this.gameLobbyMetadata.clear();
    this.serviceHosts.clear();
    this.serviceAuthorities.clear();
    this.emitGames();
    const operation = Promise.all([
      ExpoLanSockets.stopDiscoveryAsync(),
      this.stopAllWatches(),
    ]).then(() => undefined);
    this.stoppingDiscovery = operation;
    try {
      await operation;
    } finally {
      if (this.stoppingDiscovery === operation) this.stoppingDiscovery = null;
    }
  }

  async refreshDiscovery(): Promise<void> {
    await this.stopDiscovery();
    await this.startDiscovery();
  }

  async createGame<State, GameEvent>(
    options: CreateGameOptions<
      State,
      GameEvent,
      ParticipantMetadata,
      LobbyMetadata
    >
  ): Promise<GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata>> {
    this.assertNoSession();
    if (this.discovering) await this.stopDiscovery();
    const session = GameSession.host<
      State,
      GameEvent,
      ParticipantMetadata,
      LobbyMetadata
    >(this, ExpoLanSockets, options);
    this.activeSession = session as GameSession<
      unknown,
      unknown,
      ParticipantMetadata,
      LobbyMetadata
    >;
    try {
      await this.startSessionServer(session, options.name);
      return session;
    } catch (error) {
      this.activeSession = null;
      session.dispose();
      throw error;
    }
  }

  async joinGame<State, GameEvent>(
    options: JoinGameOptions<ParticipantMetadata, LobbyMetadata>
  ): Promise<GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata>> {
    this.assertNoSession();
    const session = GameSession.client<
      State,
      GameEvent,
      ParticipantMetadata,
      LobbyMetadata
    >(this, ExpoLanSockets);
    this.activeSession = session as GameSession<
      unknown,
      unknown,
      ParticipantMetadata,
      LobbyMetadata
    >;
    this.pendingJoinSession = session as GameSession<
      unknown,
      unknown,
      ParticipantMetadata,
      LobbyMetadata
    >;
    const attempt = ++this.joinAttempt;
    let connectionId: string | null = null;
    try {
      const tableId = this.serviceHosts.get(options.service.serviceId);
      const connection = await this.connectToGame(options.service, tableId, attempt);
      connectionId = connection.connectionId;
      this.assertJoinActive(attempt);
      await session.attachServer(
        connection.connectionId,
        options.participantName,
        options.participantMetadata
      );
      this.assertJoinActive(attempt);
      if (this.discovering) void this.stopDiscovery().catch(() => undefined);
      return session;
    } catch (error) {
      if (connectionId) await ExpoLanSockets.disconnectAsync(connectionId);
      if (this.activeSession === session) this.activeSession = null;
      session.dispose();
      throw error;
    } finally {
      if (this.pendingJoinSession === session) this.pendingJoinSession = null;
    }
  }

  cancelPendingJoin(): void {
    const session = this.pendingJoinSession;
    if (!session) return;
    this.joinAttempt += 1;
    this.pendingJoinSession = null;
    if (this.activeSession === session) this.activeSession = null;
    void session.suspendConnection().finally(() => session.dispose());
  }

  restoreGame<State, GameEvent>(
    options: RecoverGameOptions<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata> {
    this.assertNoSession();
    const session = GameSession.restore<State, GameEvent, ParticipantMetadata, LobbyMetadata>(
      this,
      ExpoLanSockets,
      options.recovery,
      options.selfParticipantId
    );
    this.activeSession = session as GameSession<
      unknown,
      unknown,
      ParticipantMetadata,
      LobbyMetadata
    >;
    return session;
  }

  async recoverGame<State, GameEvent>(
    session: GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata>,
    hostOptions: CreateGameOptions<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): Promise<'reconnected' | 'promoted'> {
    if (this.activeSession !== session) throw new Error('The session is no longer active');
    const snapshot = session.snapshot;
    if (!snapshot.self || !snapshot.tableId || !snapshot.hostParticipantId) {
      throw new Error('The session does not have recovery identity');
    }

    const operation = ++this.recoveryAttempt;
    const currentHostIndex = snapshot.hostOrder.indexOf(snapshot.hostParticipantId);
    const rotatedCandidates = [
      ...snapshot.hostOrder.slice(currentHostIndex + 1),
      ...snapshot.hostOrder.slice(0, currentHostIndex + 1),
    ];
    const candidatePosition = rotatedCandidates.indexOf(snapshot.self.id);
    const promoteAfter =
      Date.now() +
      RECOVERY_BASE_DELAY_MS +
      Math.max(0, candidatePosition) * RECOVERY_CANDIDATE_DELAY_MS;
    const timeoutAt = Date.now() + RECOVERY_TIMEOUT_MS;
    let highestObservedAuthorityTerm = Math.max(
      snapshot.authorityTerm,
      this.strongestObservedAuthorities.get(snapshot.tableId)?.authorityTerm ?? 0
    );
    session.markReconnecting();
    await this.startDiscovery();

    try {
      while (Date.now() < timeoutAt) {
        this.assertRecoveryActive(operation, session);
        for (const authority of this.serviceAuthorities.values()) {
          if (authority.tableId === snapshot.tableId) {
            highestObservedAuthorityTerm = Math.max(
              highestObservedAuthorityTerm,
              authority.authorityTerm
            );
          }
        }
        highestObservedAuthorityTerm = Math.max(
          highestObservedAuthorityTerm,
          this.strongestObservedAuthorities.get(snapshot.tableId)?.authorityTerm ?? 0
        );
        const service = this.bestRecoveryService(
          snapshot.tableId,
          snapshot.authorityTerm,
          snapshot.hostParticipantId,
          snapshot.hostOrder
        );
        if (service) {
          let attemptedConnectionId: string | null = null;
          let accepted = false;
          try {
            const connection = await ExpoLanSockets.connectToServiceAsync(service.serviceId);
            attemptedConnectionId = connection.connectionId;
            this.assertRecoveryActive(operation, session);
            if (session.role === 'host') session.demoteToClient();
            await session.attachResumedServer(connection.connectionId);
            await waitForConnected(
              session,
              8_000,
              () => operation === this.recoveryAttempt && this.activeSession === session
            );
            if (this.discovering) await this.stopDiscovery();
            this.assertRecoveryActive(operation, session);
            accepted = true;
            return 'reconnected';
          } catch (error) {
            if (session.snapshot.status === 'left') throw error;
            this.assertRecoveryActive(operation, session);
            this.removeGame(service.serviceId);
            await delay(CONNECT_RETRY_DELAY_MS);
          } finally {
            if (attemptedConnectionId && !accepted) {
              await ExpoLanSockets.disconnectAsync(attemptedConnectionId).catch(() => undefined);
            }
          }
        }

        if (candidatePosition >= 0 && Date.now() >= promoteAfter) {
          const previousHostParticipantId = session.snapshot.hostParticipantId!;
          const previousAuthorityTerm = session.snapshot.authorityTerm;
          if (this.discovering) await this.stopDiscovery();
          this.assertRecoveryActive(operation, session);
          let promotionBegun = false;
          try {
            session.beginPromotion(hostOptions, highestObservedAuthorityTerm);
            promotionBegun = true;
            await this.startSessionServer(session, hostOptions.name);
            this.assertRecoveryActive(operation, session);
            session.commitPromotion();
            return 'promoted';
          } catch (error) {
            if (promotionBegun) {
              await ExpoLanSockets.stopServerAsync().catch(() => undefined);
              session.abortPromotion(previousHostParticipantId, previousAuthorityTerm);
            }
            throw error;
          }
        }
        await delay(RECOVERY_POLL_MS);
      }
      throw new Error('Could not recover the table on this network');
    } finally {
      if (operation === this.recoveryAttempt && this.discovering) {
        await this.stopDiscovery().catch(() => undefined);
      }
    }
  }

  async suspendSession(): Promise<void> {
    this.recoveryAttempt += 1;
    await this.activeSession?.suspendConnection();
  }

  cancelRecovery(): void {
    this.recoveryAttempt += 1;
  }

  async startAuthorityMonitoring(): Promise<void> {
    await this.startDiscovery();
  }

  hasHigherAuthority<State, GameEvent>(
    session: GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): boolean {
    const snapshot = session.snapshot;
    if (!snapshot.tableId || !snapshot.hostParticipantId) return false;
    const currentRank = snapshot.hostOrder.indexOf(snapshot.hostParticipantId);
    const observedAuthorities = [
      ...this.serviceAuthorities.values(),
      ...(this.strongestObservedAuthorities.get(snapshot.tableId)
        ? [this.strongestObservedAuthorities.get(snapshot.tableId)!]
        : []),
    ];
    return observedAuthorities.some(
      (authority) =>
        authority.tableId === snapshot.tableId &&
        (authority.authorityTerm > snapshot.authorityTerm ||
          (authority.authorityTerm === snapshot.authorityTerm &&
            authority.hostRank < currentRank))
    );
  }

  sessionEnded(
    session: GameSession<unknown, unknown, ParticipantMetadata, LobbyMetadata>
  ): void {
    if (this.activeSession === session) this.activeSession = null;
  }

  async dispose(options: { preserveSession?: boolean } = {}): Promise<void> {
    if (options.preserveSession) {
      try {
        await this.activeSession?.suspendConnection();
      } finally {
        this.activeSession?.dispose();
      }
    } else {
      await this.activeSession?.leaveGame();
    }
    await this.stopDiscovery();
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.gamesListeners.clear();
    this.strongestObservedAuthorities.clear();
  }

  private assertNoSession(): void {
    if (this.activeSession) throw new Error('Leave the current game before starting another one');
  }

  private gameList(): DiscoveredGame<LobbyMetadata>[] {
    return [...this.games.values()]
      .flatMap((game) => {
        if (!this.gameLobbyMetadata.has(game.serviceId)) return [];
        return [
          {
            ...game,
            lobbyMetadata: this.gameLobbyMetadata.get(game.serviceId) as LobbyMetadata,
          },
        ];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private emitGames(): void {
    const games = this.gameList();
    this.gamesListeners.forEach((listener) => listener(games));
  }

  private async startWatchingGame(service: DiscoveredService): Promise<void> {
    const generation = this.watchGeneration;
    const pendingKey = `${generation}:${service.serviceId}`;
    if (
      this.activeSession ||
      this.gameWatches.has(service.serviceId) ||
      this.pendingWatches.has(pendingKey)
    ) {
      return;
    }
    this.pendingWatches.add(pendingKey);
    let connectionId: string | null = null;
    try {
      const connection = await ExpoLanSockets.connectToServiceAsync(service.serviceId);
      connectionId = connection.connectionId;
      if (
        !this.discovering ||
        generation !== this.watchGeneration ||
        !this.games.has(service.serviceId) ||
        this.activeSession
      ) {
        await ExpoLanSockets.disconnectAsync(connection.connectionId);
        return;
      }

      const watch: GameWatch<ParticipantMetadata, LobbyMetadata> = {
        connectionId: connection.connectionId,
        decoder: new MessageDecoder(),
        timeout: setTimeout(() => {
          this.removeUnavailableGame(service.serviceId);
        }, WATCH_ACK_TIMEOUT_MS),
      };
      this.gameWatches.set(service.serviceId, watch);
      this.watchConnections.set(connection.connectionId, service.serviceId);
      await ExpoLanSockets.sendAsync(
        connection.connectionId,
        encodeMessage({ v: PROTOCOL_VERSION, kind: 'watch' })
      );
    } catch {
      if (connectionId) await ExpoLanSockets.disconnectAsync(connectionId).catch(() => undefined);
      if (
        this.discovering &&
        generation === this.watchGeneration &&
        this.games.has(service.serviceId)
      ) {
        this.removeUnavailableGame(service.serviceId);
      }
    } finally {
      this.pendingWatches.delete(pendingKey);
    }
  }

  private receiveWatchMessage(event: MessageEvent): boolean {
    const serviceId = this.watchConnections.get(event.connectionId);
    if (!serviceId) return false;
    const watch = this.gameWatches.get(serviceId);
    if (!watch || watch.connectionId !== event.connectionId) return true;
    try {
      for (const message of watch.decoder.push(event.data)) {
        if (message.kind !== 'watching') continue;
        if (message.phase !== 'lobby') {
          this.removeUnavailableGame(serviceId);
          return true;
        }
        if (!isJsonValue(message.lobbyMetadata)) {
          this.removeUnavailableGame(serviceId);
          return true;
        }
        clearTimeout(watch.timeout);
        this.gameLobbyMetadata.set(serviceId, message.lobbyMetadata as LobbyMetadata);
        this.emitGames();
      }
    } catch {
      this.removeUnavailableGame(serviceId);
    }
    return true;
  }

  private watchClosed(connectionId: string): boolean {
    const serviceId = this.watchConnections.get(connectionId);
    if (!serviceId) return false;
    const watch = this.gameWatches.get(serviceId);
    if (watch?.connectionId === connectionId) {
      clearTimeout(watch.timeout);
      this.gameWatches.delete(serviceId);
    }
    this.watchConnections.delete(connectionId);
    const wasVisible = this.gameLobbyMetadata.delete(serviceId);
    this.games.delete(serviceId);
    this.serviceHosts.delete(serviceId);
    this.serviceAuthorities.delete(serviceId);
    if (this.discovering && wasVisible) {
      this.emitGames();
    }
    return true;
  }

  private removeGame(serviceId: string): boolean {
    const removed = this.gameLobbyMetadata.delete(serviceId);
    this.games.delete(serviceId);
    this.serviceHosts.delete(serviceId);
    this.serviceAuthorities.delete(serviceId);
    const watch = this.gameWatches.get(serviceId);
    if (watch) {
      clearTimeout(watch.timeout);
      this.gameWatches.delete(serviceId);
      this.watchConnections.delete(watch.connectionId);
      void ExpoLanSockets.disconnectAsync(watch.connectionId).catch(() => undefined);
    }
    return removed;
  }

  private removeUnavailableGame(serviceId: string): void {
    if (this.removeGame(serviceId)) this.emitGames();
  }

  private async stopAllWatches(): Promise<void> {
    const connectionIds = [...this.gameWatches.values()].map((watch) => {
      clearTimeout(watch.timeout);
      return watch.connectionId;
    });
    this.gameWatches.clear();
    this.watchConnections.clear();
    await Promise.allSettled(
      connectionIds.map((connectionId) => ExpoLanSockets.disconnectAsync(connectionId))
    );
  }

  private async connectToGame(
    service: DiscoveredService,
    tableId: string | undefined,
    joinAttempt: number
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
      this.assertJoinActive(joinAttempt);
      const currentService = tableId
        ? [...this.serviceHosts].find(([, candidateTableId]) => candidateTableId === tableId)?.[0]
        : service.serviceId;
      try {
        return await ExpoLanSockets.connectToServiceAsync(currentService ?? service.serviceId);
      } catch (error) {
        lastError = error;
        if (attempt < CONNECT_ATTEMPTS - 1) await delay(CONNECT_RETRY_DELAY_MS);
      }
    }
    throw lastError;
  }

  private assertJoinActive(attempt: number): void {
    if (attempt !== this.joinAttempt) throw new Error('Join cancelled');
  }

  private assertRecoveryActive<State, GameEvent>(
    attempt: number,
    session: GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata>
  ): void {
    if (attempt !== this.recoveryAttempt || this.activeSession !== session) {
      throw new Error('Recovery cancelled');
    }
  }

  private bestRecoveryService(
    tableId: string,
    authorityTerm: number,
    hostParticipantId: string,
    hostOrder: readonly string[]
  ): DiscoveredService | null {
    const currentHostRank = hostOrder.indexOf(hostParticipantId);
    const candidates = [...this.serviceAuthorities.entries()]
      .filter(([, authority]) =>
        authority.tableId === tableId &&
        (authority.authorityTerm > authorityTerm ||
          (authority.authorityTerm === authorityTerm && authority.hostRank <= currentHostRank))
      )
      .sort((left, right) =>
        right[1].authorityTerm - left[1].authorityTerm ||
        left[1].hostRank - right[1].hostRank
      );
    const serviceId = candidates[0]?.[0];
    return serviceId ? this.games.get(serviceId) ?? null : null;
  }

  private async startSessionServer<State, GameEvent>(
    session: GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata>,
    visibleName: string
  ): Promise<void> {
    const snapshot = session.snapshot;
    if (!snapshot.tableId || !snapshot.hostParticipantId) {
      throw new Error('The host session is missing authority identity');
    }
    const name = (visibleName.trim() || 'LAN Game').slice(0, 20);
    const hostRank = Math.max(0, snapshot.hostOrder.indexOf(snapshot.hostParticipantId));
    const serviceName = [
      name,
      snapshot.tableId,
      snapshot.authorityTerm.toString(36),
      hostRank.toString(36),
      randomId(),
    ].join('~');
    await ExpoLanSockets.startServerAsync({ serviceName, serviceType: SERVICE_TYPE });
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 2 + SERVICE_ID_LENGTH).padEnd(SERVICE_ID_LENGTH, '0');
}

function parseAdvertisedName(name: string): AdvertisedGame | null {
  const match = name.match(/^(.*)~([a-z0-9]{12})~([a-z0-9]+)~([a-z0-9]+)~[a-z0-9]{6}$/);
  if (!match) return null;
  const authorityTerm = Number.parseInt(match[3]!, 36);
  const hostRank = Number.parseInt(match[4]!, 36);
  if (!Number.isSafeInteger(authorityTerm) || !Number.isSafeInteger(hostRank)) return null;
  return {
    name: match[1] || 'LAN Game',
    tableId: match[2]!,
    authorityTerm,
    hostRank,
  };
}

function outranks(candidate: AdvertisedGame, current: AdvertisedGame): boolean {
  return (
    candidate.authorityTerm > current.authorityTerm ||
    (candidate.authorityTerm === current.authorityTerm && candidate.hostRank < current.hostRank)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}

function waitForConnected<
  State,
  GameEvent,
  ParticipantMetadata extends JsonValue,
  LobbyMetadata extends JsonValue,
>(
  session: GameSession<State, GameEvent, ParticipantMetadata, LobbyMetadata>,
  timeoutMs: number,
  isActive: () => boolean
): Promise<void> {
  if (session.snapshot.status === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancellationCheck);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      finish(new Error('The recovered host did not accept the participant'));
    }, timeoutMs);
    const cancellationCheck = setInterval(() => {
      if (!isActive()) finish(new Error('Recovery cancelled'));
    }, 100);
    unsubscribe = session.subscribe((snapshot) => {
      if (snapshot.status === 'connected') {
        finish();
      } else if (snapshot.status === 'left') {
        finish(new Error(snapshot.error ?? 'The recovery identity was rejected'));
      }
    });
    if (settled) unsubscribe();
  });
}
