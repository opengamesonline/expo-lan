import type { DiscoveredService, LanSocketsErrorEvent } from '@opengamesonline/expo-lan-sockets';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Participant<Metadata extends JsonValue = JsonValue> = {
  id: string;
  name: string;
  slot: number;
  metadata: Metadata;
};

export type SessionRole = 'host' | 'client';
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'left';
export type GamePhase = 'lobby' | 'started';

export type DiscoveredGame<LobbyMetadata extends JsonValue = JsonValue> = DiscoveredService & {
  lobbyMetadata: LobbyMetadata;
};

export type SessionSnapshot<
  State,
  ParticipantMetadata extends JsonValue = JsonValue,
  LobbyMetadata extends JsonValue = JsonValue,
> = {
  role: SessionRole;
  status: SessionStatus;
  phase: GamePhase;
  state: State | null;
  revision: number;
  self: Participant<ParticipantMetadata> | null;
  participants: Participant<ParticipantMetadata>[];
  lobbyMetadata: LobbyMetadata | null;
  error: string | null;
};

export type CreateGameOptions<
  State,
  GameEvent,
  ParticipantMetadata extends JsonValue,
  LobbyMetadata extends JsonValue,
> = {
  name: string;
  participantName: string;
  participantMetadata: ParticipantMetadata;
  createInitialState(participants: readonly Participant<ParticipantMetadata>[]): State;
  reduceEvent(
    state: State,
    event: GameEvent,
    participant: Participant<ParticipantMetadata>
  ): State;
  getLobbyMetadata(
    participants: readonly Participant<ParticipantMetadata>[]
  ): LobbyMetadata;
  validateJoin?(
    candidate: Participant<ParticipantMetadata>,
    participants: readonly Participant<ParticipantMetadata>[]
  ): string | null | undefined;
  validateStart?(
    participants: readonly Participant<ParticipantMetadata>[]
  ): string | null | undefined;
};

export type JoinGameOptions<
  ParticipantMetadata extends JsonValue,
  LobbyMetadata extends JsonValue,
> = {
  service: DiscoveredGame<LobbyMetadata>;
  participantName: string;
  participantMetadata: ParticipantMetadata;
};

export type GamesListener<LobbyMetadata extends JsonValue = JsonValue> = (
  games: DiscoveredGame<LobbyMetadata>[]
) => void;
export type SessionListener<
  State,
  ParticipantMetadata extends JsonValue = JsonValue,
  LobbyMetadata extends JsonValue = JsonValue,
> = (snapshot: SessionSnapshot<State, ParticipantMetadata, LobbyMetadata>) => void;
export type MultiplayerError = LanSocketsErrorEvent;
