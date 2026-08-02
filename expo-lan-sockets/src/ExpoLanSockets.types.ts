export type LanSocketsCapabilities = {
  tcpServer: boolean;
  tcpClient: boolean;
  serviceDiscovery: boolean;
};

export type ServerOptions = {
  serviceName: string;
  serviceType: string;
};

export type ServerInfo = ServerOptions & {
  port: number;
};

export type DiscoveredService = {
  serviceId: string;
  name: string;
  type: string;
};

export type ConnectionInfo = {
  connectionId: string;
  remoteAddress: string | null;
  remotePort: number;
  incoming: boolean;
};

export type MessageEvent = {
  connectionId: string;
  data: Uint8Array;
};

export type ConnectionClosedEvent = {
  connectionId: string;
  reason: 'local_close' | 'remote_close' | 'server_stopped' | 'connection_error';
  message?: string;
};

export type LanSocketsErrorEvent = {
  code: string;
  message: string;
  operation: 'server' | 'discovery' | 'connection';
};

export type ExpoLanSocketsEvents = {
  onServiceFound(event: DiscoveredService): void;
  onServiceLost(event: { serviceId: string }): void;
  onConnectionOpened(event: ConnectionInfo): void;
  onMessage(event: MessageEvent): void;
  onConnectionClosed(event: ConnectionClosedEvent): void;
  onError(event: LanSocketsErrorEvent): void;
};
