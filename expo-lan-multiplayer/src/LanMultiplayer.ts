import ExpoLanSockets, {
  type ConnectionClosedEvent,
  type DiscoveredService,
  type LanSocketsErrorEvent,
  type MessageEvent,
} from '@opengamesonline/expo-lan-sockets';

import { GameSession } from './GameSession';
import { SERVICE_TYPE } from './protocol';
import type { CreateGameOptions, GamesListener, JoinGameOptions } from './types';

type Subscription = { remove(): void };

export class LanMultiplayer {
  private readonly games = new Map<string, DiscoveredService>();
  private readonly gamesListeners = new Set<GamesListener>();
  private readonly subscriptions: Subscription[];
  private activeSession: GameSession<unknown, unknown> | null = null;
  private discovering = false;

  constructor() {
    this.subscriptions = [
      ExpoLanSockets.addListener('onServiceFound', (service) => {
        this.games.set(service.serviceId, service);
        this.emitGames();
      }),
      ExpoLanSockets.addListener('onServiceLost', ({ serviceId }) => {
        this.games.delete(serviceId);
        this.emitGames();
      }),
      ExpoLanSockets.addListener('onConnectionOpened', (connection) => {
        if (connection.incoming) this.activeSession?.attachIncoming(connection.connectionId);
      }),
      ExpoLanSockets.addListener('onMessage', (event: MessageEvent) => {
        this.activeSession?.receive(event.connectionId, event.data);
      }),
      ExpoLanSockets.addListener('onConnectionClosed', (event: ConnectionClosedEvent) => {
        this.activeSession?.disconnected(event.connectionId);
      }),
      ExpoLanSockets.addListener('onError', (event: LanSocketsErrorEvent) => {
        this.activeSession?.fail(event.message);
      }),
    ];
  }

  get capabilities() {
    return ExpoLanSockets.capabilities;
  }

  subscribeToGames(listener: GamesListener): () => void {
    this.gamesListeners.add(listener);
    listener(this.gameList());
    return () => this.gamesListeners.delete(listener);
  }

  async startDiscovery(): Promise<void> {
    if (this.discovering) return;
    await ExpoLanSockets.startDiscoveryAsync(SERVICE_TYPE);
    this.discovering = true;
  }

  async stopDiscovery(): Promise<void> {
    if (!this.discovering) return;
    await ExpoLanSockets.stopDiscoveryAsync();
    this.discovering = false;
    this.games.clear();
    this.emitGames();
  }

  async createGame<State, GameEvent>(
    options: CreateGameOptions<State, GameEvent>
  ): Promise<GameSession<State, GameEvent>> {
    this.assertNoSession();
    if (this.discovering) await this.stopDiscovery();
    const session = GameSession.host<State, GameEvent>(this, options);
    this.activeSession = session as GameSession<unknown, unknown>;
    try {
      await ExpoLanSockets.startServerAsync({ serviceName: options.name.trim() || 'LAN Game', serviceType: SERVICE_TYPE });
      return session;
    } catch (error) {
      this.activeSession = null;
      throw error;
    }
  }

  async joinGame<State, GameEvent>(options: JoinGameOptions): Promise<GameSession<State, GameEvent>> {
    this.assertNoSession();
    const session = GameSession.client<State, GameEvent>(this);
    this.activeSession = session as GameSession<unknown, unknown>;
    let connectionId: string | null = null;
    try {
      const connection = await ExpoLanSockets.connectToServiceAsync(options.service.serviceId);
      connectionId = connection.connectionId;
      if (this.discovering) await this.stopDiscovery();
      await session.attachServer(connection.connectionId, options.playerName);
      return session;
    } catch (error) {
      if (connectionId) await ExpoLanSockets.disconnectAsync(connectionId);
      this.activeSession = null;
      throw error;
    }
  }

  sessionEnded(session: GameSession<unknown, unknown>): void {
    if (this.activeSession === session) this.activeSession = null;
  }

  async dispose(): Promise<void> {
    await this.activeSession?.leaveGame();
    await this.stopDiscovery();
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.gamesListeners.clear();
  }

  private assertNoSession(): void {
    if (this.activeSession) throw new Error('Leave the current game before starting another one');
  }

  private gameList(): DiscoveredService[] {
    return [...this.games.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private emitGames(): void {
    const games = this.gameList();
    this.gamesListeners.forEach((listener) => listener(games));
  }
}
