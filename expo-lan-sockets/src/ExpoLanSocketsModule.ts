import { NativeModule, requireNativeModule } from 'expo';

import type {
  ConnectionInfo,
  ExpoLanSocketsEvents,
  LanSocketsCapabilities,
  ServerInfo,
  ServerOptions,
} from './ExpoLanSockets.types';

declare class ExpoLanSocketsModule extends NativeModule<ExpoLanSocketsEvents> {
  readonly capabilities: LanSocketsCapabilities;

  startServerAsync(options: ServerOptions): Promise<ServerInfo>;
  stopServerAsync(): Promise<void>;
  startDiscoveryAsync(serviceType: string): Promise<void>;
  stopDiscoveryAsync(): Promise<void>;
  connectAsync(host: string, port: number): Promise<ConnectionInfo>;
  connectToServiceAsync(serviceId: string): Promise<ConnectionInfo>;
  sendAsync(connectionId: string, data: Uint8Array): Promise<void>;
  broadcastAsync(data: Uint8Array): Promise<void>;
  disconnectAsync(connectionId: string): Promise<void>;
}

export default requireNativeModule<ExpoLanSocketsModule>('ExpoLanSockets');
