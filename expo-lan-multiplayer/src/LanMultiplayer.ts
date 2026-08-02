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

const SERVICE_ID_LENGTH = 6;
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 500;

export class LanMultiplayer {
  private readonly games = new Map<string, DiscoveredService>();
  private readonly serviceHosts = new Map<string, string>();
  private readonly gamesListeners = new Set<GamesListener>();
  private readonly subscriptions: Subscription[];
  private readonly hostId = randomId();
  private activeSession: GameSession<unknown, unknown> | null = null;
  private discovering = false;

  constructor() {
    this.subscriptions = [
      ExpoLanSockets.addListener('onServiceFound', (service) => {
        const advertised = parseAdvertisedName(service.name);
        if (advertised) {
          for (const [serviceId, hostId] of this.serviceHosts) {
            if (hostId === advertised.hostId && serviceId !== service.serviceId) {
              this.games.delete(serviceId);
              this.serviceHosts.delete(serviceId);
            }
          }
          this.serviceHosts.set(service.serviceId, advertised.hostId);
          this.games.set(service.serviceId, { ...service, name: advertised.name });
        } else {
          this.games.set(service.serviceId, service);
        }
        this.emitGames();
      }),
      ExpoLanSockets.addListener('onServiceLost', ({ serviceId }) => {
        this.games.delete(serviceId);
        this.serviceHosts.delete(serviceId);
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
    this.serviceHosts.clear();
    this.emitGames();
  }

  async createGame<State, GameEvent>(
    options: CreateGameOptions<State, GameEvent>
  ): Promise<GameSession<State, GameEvent>> {
    this.assertNoSession();
    if (this.discovering) await this.stopDiscovery();
    const session = GameSession.host<State, GameEvent>(this, ExpoLanSockets, options);
    this.activeSession = session as GameSession<unknown, unknown>;
    try {
      const name = (options.name.trim() || 'LAN Game').slice(0, 32);
      const serviceName = `${name}~${this.hostId}~${randomId()}`;
      await ExpoLanSockets.startServerAsync({ serviceName, serviceType: SERVICE_TYPE });
      return session;
    } catch (error) {
      this.activeSession = null;
      throw error;
    }
  }

  async joinGame<State, GameEvent>(options: JoinGameOptions): Promise<GameSession<State, GameEvent>> {
    this.assertNoSession();
    const session = GameSession.client<State, GameEvent>(this, ExpoLanSockets);
    this.activeSession = session as GameSession<unknown, unknown>;
    let connectionId: string | null = null;
    try {
      const hostId = this.serviceHosts.get(options.service.serviceId);
      const connection = await this.connectToGame(options.service, hostId);
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

  private async connectToGame(service: DiscoveredService, hostId?: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
      const currentService = hostId
        ? [...this.serviceHosts].find(([, candidateHostId]) => candidateHostId === hostId)?.[0]
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
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 2 + SERVICE_ID_LENGTH).padEnd(SERVICE_ID_LENGTH, '0');
}

function parseAdvertisedName(name: string): { name: string; hostId: string } | null {
  const match = name.match(/^(.*)~([a-z0-9]{6})~[a-z0-9]{6}$/);
  if (!match) return null;
  return { name: match[1] || 'LAN Game', hostId: match[2] };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
