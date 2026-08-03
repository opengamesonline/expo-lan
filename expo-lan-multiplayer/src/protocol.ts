import type { GamePhase, JsonValue, Participant } from './types';

export const PROTOCOL_VERSION = 1;
export const SERVICE_TYPE = '_expo-lan-game._tcp.';
export const MAX_FRAME_BYTES = 64 * 1024;
export const WATCH_ACK_TIMEOUT_MS = 2000;

export type WireMessage<
  State,
  GameEvent,
  ParticipantMetadata extends JsonValue = JsonValue,
  LobbyMetadata extends JsonValue = JsonValue,
> = { v: typeof PROTOCOL_VERSION } & (
  | { kind: 'watch' }
  | { kind: 'watching'; phase: GamePhase; lobbyMetadata: LobbyMetadata }
  | { kind: 'join'; participantName: string; participantMetadata: ParticipantMetadata }
  | {
      kind: 'welcome';
      self: Participant<ParticipantMetadata>;
      participants: Participant<ParticipantMetadata>[];
      state: State | null;
      revision: number;
      phase: GamePhase;
      lobbyMetadata: LobbyMetadata;
    }
  | {
      kind: 'participantJoined';
      participant: Participant<ParticipantMetadata>;
      lobbyMetadata: LobbyMetadata;
    }
  | { kind: 'participantLeft'; participantId: string; lobbyMetadata: LobbyMetadata }
  | { kind: 'gameStarted'; state: State; revision: number }
  | { kind: 'gameEvent'; event: GameEvent }
  | { kind: 'state'; state: State; revision: number }
  | { kind: 'leave' }
  | { kind: 'rejected'; reason: string }
);

const textEncoder = new TextEncoder();

export function encodeMessage<
  State,
  GameEvent,
  ParticipantMetadata extends JsonValue = JsonValue,
  LobbyMetadata extends JsonValue = JsonValue,
>(message: WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>): Uint8Array {
  const data = textEncoder.encode(`${JSON.stringify(message)}\n`);
  if (data.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`LAN message exceeds the ${MAX_FRAME_BYTES} byte limit`);
  }
  return data;
}

export class MessageDecoder<
  State,
  GameEvent,
  ParticipantMetadata extends JsonValue = JsonValue,
  LobbyMetadata extends JsonValue = JsonValue,
> {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  push(
    data: Uint8Array
  ): Array<WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>> {
    this.buffer += this.decoder.decode(data, { stream: true });
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.buffer = '';
      throw new Error(`LAN message exceeds the ${MAX_FRAME_BYTES} byte limit`);
    }

    const messages: Array<
      WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>
    > = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const frame = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (frame.length > 0) {
        messages.push(
          parseMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>(frame)
        );
      }
      newline = this.buffer.indexOf('\n');
    }
    return messages;
  }
}

function parseMessage<
  State,
  GameEvent,
  ParticipantMetadata extends JsonValue,
  LobbyMetadata extends JsonValue,
>(frame: string): WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata> {
  const message: unknown = JSON.parse(frame);
  if (typeof message !== 'object' || message === null) throw new Error('Invalid LAN message');
  const envelope = message as { v?: unknown; kind?: unknown };
  if (envelope.v !== PROTOCOL_VERSION || typeof envelope.kind !== 'string') {
    throw new Error('Unsupported LAN protocol message');
  }
  return message as WireMessage<State, GameEvent, ParticipantMetadata, LobbyMetadata>;
}
