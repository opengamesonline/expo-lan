import { registerWebModule, NativeModule } from 'expo';

import type {
  ConnectionInfo,
  ExpoLanSocketsEvents,
  LanSocketsCapabilities,
  ServerInfo,
  ServerOptions,
} from './ExpoLanSockets.types';

const unsupported = (): never => {
  throw new Error('Expo LAN sockets are not supported on web');
};

class ExpoLanSocketsModule extends NativeModule<ExpoLanSocketsEvents> {
  readonly capabilities: LanSocketsCapabilities = {
    tcpServer: false,
    tcpClient: false,
    serviceDiscovery: false,
  };

  async startServerAsync(_options: ServerOptions): Promise<ServerInfo> {
    return unsupported();
  }

  async stopServerAsync(): Promise<void> {
    return unsupported();
  }

  async startDiscoveryAsync(_serviceType: string): Promise<void> {
    return unsupported();
  }

  async stopDiscoveryAsync(): Promise<void> {
    return unsupported();
  }

  async connectAsync(_host: string, _port: number): Promise<ConnectionInfo> {
    return unsupported();
  }

  async connectToServiceAsync(_serviceId: string): Promise<ConnectionInfo> {
    return unsupported();
  }

  async sendAsync(_connectionId: string, _data: Uint8Array): Promise<void> {
    return unsupported();
  }

  async broadcastAsync(_data: Uint8Array): Promise<void> {
    return unsupported();
  }

  async disconnectAsync(_connectionId: string): Promise<void> {
    return unsupported();
  }
}

export default registerWebModule(ExpoLanSocketsModule, 'ExpoLanSockets');
