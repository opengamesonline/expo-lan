export interface SessionTransport {
  sendAsync(connectionId: string, data: Uint8Array): Promise<void>;
  disconnectAsync(connectionId: string): Promise<void>;
  stopServerAsync(): Promise<void>;
}
