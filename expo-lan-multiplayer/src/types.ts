import type { DiscoveredService, LanSocketsErrorEvent } from '@opengamesonline/expo-lan-sockets';

export type Player = {
  id: string;
  name: string;
  slot: number;
};

export type SessionRole = 'host' | 'client';
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'left';
export type GamePhase = 'lobby' | 'started';

export type SessionSnapshot<State> = {
  role: SessionRole;
  status: SessionStatus;
  phase: GamePhase;
  state: State | null;
  revision: number;
  self: Player | null;
  players: Player[];
  error: string | null;
};

export type CreateGameOptions<State, GameEvent> = {
  name: string;
  playerName: string;
  initialState: State;
  maxPlayers?: number;
  reduceEvent(state: State, event: GameEvent, player: Player): State;
};

export type JoinGameOptions = {
  service: DiscoveredService;
  playerName: string;
};

export type GamesListener = (games: DiscoveredService[]) => void;
export type SessionListener<State> = (snapshot: SessionSnapshot<State>) => void;
export type MultiplayerError = LanSocketsErrorEvent;
