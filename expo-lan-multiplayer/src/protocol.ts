import type { GamePhase, Player } from './types';

export const PROTOCOL_VERSION = 1;
export const SERVICE_TYPE = '_expo-lan-game._tcp.';
export const MAX_FRAME_BYTES = 64 * 1024;

export type WireMessage<State, GameEvent> =
  | { v: 1; kind: 'join'; playerName: string }
  | { v: 1; kind: 'welcome'; self: Player; players: Player[]; state: State; revision: number; phase: GamePhase }
  | { v: 1; kind: 'playerJoined'; player: Player }
  | { v: 1; kind: 'playerLeft'; playerId: string }
  | { v: 1; kind: 'gameStarted'; state: State; revision: number }
  | { v: 1; kind: 'gameEvent'; event: GameEvent }
  | { v: 1; kind: 'state'; state: State; revision: number }
  | { v: 1; kind: 'leave' }
  | { v: 1; kind: 'rejected'; reason: string };

const textEncoder = new TextEncoder();

export function encodeMessage<State, GameEvent>(message: WireMessage<State, GameEvent>): Uint8Array {
  const data = textEncoder.encode(`${JSON.stringify(message)}\n`);
  if (data.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`LAN message exceeds the ${MAX_FRAME_BYTES} byte limit`);
  }
  return data;
}

export class MessageDecoder<State, GameEvent> {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  push(data: Uint8Array): Array<WireMessage<State, GameEvent>> {
    this.buffer += this.decoder.decode(data, { stream: true });
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.buffer = '';
      throw new Error(`LAN message exceeds the ${MAX_FRAME_BYTES} byte limit`);
    }

    const messages: Array<WireMessage<State, GameEvent>> = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const frame = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (frame.length > 0) messages.push(parseMessage<State, GameEvent>(frame));
      newline = this.buffer.indexOf('\n');
    }
    return messages;
  }
}

function parseMessage<State, GameEvent>(frame: string): WireMessage<State, GameEvent> {
  const message: unknown = JSON.parse(frame);
  if (typeof message !== 'object' || message === null) throw new Error('Invalid LAN message');
  const envelope = message as { v?: unknown; kind?: unknown };
  if (envelope.v !== PROTOCOL_VERSION || typeof envelope.kind !== 'string') {
    throw new Error('Unsupported LAN protocol message');
  }
  return message as WireMessage<State, GameEvent>;
}
