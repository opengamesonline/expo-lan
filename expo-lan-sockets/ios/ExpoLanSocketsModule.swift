import ExpoModulesCore
import Network

private let maxConnections = 32
private let connectTimeout: TimeInterval = 10

private struct ServerOptions: Record {
  @Field
  var serviceName: String = "Expo LAN Game"

  @Field
  var serviceType: String = "_expo-lan-game._tcp."
}

private final class ManagedConnection {
  let id: String
  let connection: NWConnection
  let incoming: Bool
  var opened = false
  var closed = false
  var receiving = false
  var connectPromise: Promise?
  var timeoutWorkItem: DispatchWorkItem?

  init(id: String, connection: NWConnection, incoming: Bool, promise: Promise?) {
    self.id = id
    self.connection = connection
    self.incoming = incoming
    self.connectPromise = promise
  }
}

public final class ExpoLanSocketsModule: Module {
  private let networkQueue = DispatchQueue(label: "expo.lan.sockets.network")
  private var listener: NWListener?
  private var browser: NWBrowser?
  private var connections: [String: ManagedConnection] = [:]
  private var discoveredServices: [String: NWEndpoint] = [:]
  private var discoveredServiceIds: [String: String] = [:]
  private var destroyed = false

  public func definition() -> ModuleDefinition {
    Name("ExpoLanSockets")

    Events(
      "onServiceFound",
      "onServiceLost",
      "onConnectionOpened",
      "onMessage",
      "onConnectionClosed",
      "onError"
    )

    Constant("capabilities") {
      return [
        "tcpServer": true,
        "tcpClient": true,
        "serviceDiscovery": true
      ]
    }

    AsyncFunction("startServerAsync") { (options: ServerOptions, promise: Promise) in
      self.startServer(options: options, promise: promise)
    }

    AsyncFunction("stopServerAsync") { (promise: Promise) in
      self.networkQueue.async {
        self.stopServer()
        promise.resolve()
      }
    }

    AsyncFunction("startDiscoveryAsync") { (serviceType: String, promise: Promise) in
      self.startDiscovery(serviceType: serviceType, promise: promise)
    }

    AsyncFunction("stopDiscoveryAsync") {
      self.stopDiscovery()
    }
    .runOnQueue(networkQueue)

    AsyncFunction("connectAsync") { (host: String, port: Int, promise: Promise) in
      self.networkQueue.async {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(exactly: port) ?? 0), nwPort.rawValue > 0 else {
          promise.reject("ERR_INVALID_PORT", "Port must be between 1 and 65535")
          return
        }
        self.connect(endpoint: .hostPort(host: NWEndpoint.Host(host), port: nwPort), promise: promise)
      }
    }

    AsyncFunction("connectToServiceAsync") { (serviceId: String, promise: Promise) in
      self.networkQueue.async {
        guard let endpoint = self.discoveredServices[serviceId] else {
          promise.reject("ERR_SERVICE_NOT_FOUND", "Service '\(serviceId)' was not found")
          return
        }
        self.connect(endpoint: endpoint, promise: promise)
      }
    }

    AsyncFunction("sendAsync") { (connectionId: String, data: Data, promise: Promise) in
      self.networkQueue.async {
        self.send(connectionId: connectionId, data: data, promise: promise)
      }
    }

    AsyncFunction("broadcastAsync") { (data: Data, promise: Promise) in
      self.networkQueue.async {
        self.broadcast(data: data, promise: promise)
      }
    }

    AsyncFunction("disconnectAsync") { (connectionId: String, promise: Promise) in
      self.networkQueue.async {
        if let connection = self.connections[connectionId] {
          self.closeConnection(connection, reason: "local_close")
        }
        promise.resolve()
      }
    }

    OnDestroy {
      self.networkQueue.sync {
        self.destroyed = true
        self.stopDiscovery()
        self.stopServer()
        Array(self.connections.values).forEach { connection in
          self.closeConnection(connection, reason: "local_close", emit: false)
        }
      }
    }
  }

  private func startServer(options: ServerOptions, promise: Promise) {
    networkQueue.async {
      guard self.listener == nil else {
        promise.reject("ERR_SERVER_ALREADY_RUNNING", "A server is already running")
        return
      }
      guard !self.destroyed else {
        promise.reject("ERR_SERVER_START", "The server cannot be started")
        return
      }

      do {
        let parameters = self.tcpParameters()
        let listener = try NWListener(using: parameters, on: .any)
        var didSettleStart = false
        listener.service = NWListener.Service(
          name: options.serviceName,
          type: self.normalizedServiceType(options.serviceType)
        )
        self.listener = listener

        listener.newConnectionHandler = { [weak self, weak listener] connection in
          guard let self, let listener, self.listener === listener else {
            connection.cancel()
            return
          }
          self.networkQueue.async {
            guard self.listener === listener, self.connections.count < maxConnections else {
              connection.cancel()
              return
            }
            self.addConnection(connection, incoming: true, promise: nil)
          }
        }

        listener.stateUpdateHandler = { [weak self, weak listener] state in
          guard let self, let listener else { return }
          self.networkQueue.async {
            guard self.listener === listener else { return }
            switch state {
            case .ready:
              guard !didSettleStart else { return }
              didSettleStart = true
              guard let port = listener.port?.rawValue else {
                self.listener = nil
                listener.cancel()
                promise.reject("ERR_SERVER_START", "The TCP listener has no port")
                return
              }
              promise.resolve([
                "port": Int(port),
                "serviceName": options.serviceName,
                "serviceType": options.serviceType
              ])
            case .failed(let error):
              self.listener = nil
              listener.cancel()
              self.closeIncomingConnections(reason: "server_stopped")
              if didSettleStart {
                self.emitError(code: "ERR_SERVER_FAILED", message: error.localizedDescription, operation: "server")
              } else {
                didSettleStart = true
                promise.reject("ERR_SERVER_START", error.localizedDescription)
              }
            case .waiting(let error):
              self.listener = nil
              listener.cancel()
              if didSettleStart {
                self.emitError(code: "ERR_SERVER_FAILED", message: error.localizedDescription, operation: "server")
              } else {
                didSettleStart = true
                promise.reject("ERR_SERVER_START", error.localizedDescription)
              }
            default:
              break
            }
          }
        }
        listener.start(queue: self.networkQueue)
      } catch {
        self.listener = nil
        promise.reject("ERR_SERVER_START", error.localizedDescription)
      }
    }
  }

  private func stopServer() {
    listener?.stateUpdateHandler = nil
    listener?.newConnectionHandler = nil
    listener?.cancel()
    listener = nil
    closeIncomingConnections(reason: "server_stopped")
  }

  private func closeIncomingConnections(reason: String) {
    connections.values.filter(\.incoming).forEach { connection in
      closeConnection(connection, reason: reason)
    }
  }

  private func startDiscovery(serviceType: String, promise: Promise) {
    networkQueue.async {
      guard !self.destroyed else {
        promise.reject("ERR_DISCOVERY_START", "Service discovery cannot be started")
        return
      }
      if self.browser != nil {
        self.stopDiscovery()
      }

      let browser = NWBrowser(
        for: .bonjour(type: self.normalizedServiceType(serviceType), domain: nil),
        using: self.tcpParameters()
      )
      var didSettleStart = false
      self.browser = browser
      browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
        guard let self, let browser else { return }
        self.networkQueue.async {
          guard self.browser === browser else { return }
          self.updateDiscoveredServices(results)
        }
      }
      browser.stateUpdateHandler = { [weak self, weak browser] state in
        guard let self, let browser else { return }
        self.networkQueue.async {
          guard self.browser === browser else { return }
          switch state {
          case .ready:
            if !didSettleStart {
              didSettleStart = true
              promise.resolve()
            }
          case .failed(let error):
            self.stopDiscovery()
            if didSettleStart {
              self.emitError(code: "ERR_DISCOVERY_FAILED", message: error.localizedDescription, operation: "discovery")
            } else {
              didSettleStart = true
              promise.reject("ERR_DISCOVERY_START", error.localizedDescription)
            }
          case .waiting(let error):
            self.stopDiscovery()
            if didSettleStart {
              self.emitError(code: "ERR_DISCOVERY_FAILED", message: error.localizedDescription, operation: "discovery")
            } else {
              didSettleStart = true
              promise.reject("ERR_DISCOVERY_START", error.localizedDescription)
            }
          default:
            break
          }
        }
      }
      browser.start(queue: self.networkQueue)
    }
  }

  private func stopDiscovery() {
    browser?.stateUpdateHandler = nil
    browser?.browseResultsChangedHandler = nil
    browser?.cancel()
    browser = nil
    discoveredServices.removeAll()
    discoveredServiceIds.removeAll()
  }

  private func updateDiscoveredServices(_ results: Set<NWBrowser.Result>) {
    var activeKeys = Set<String>()
    for result in results {
      guard let service = serviceDetails(result.endpoint) else { continue }
      activeKeys.insert(service.key)
      let serviceId = discoveredServiceIds[service.key] ?? UUID().uuidString
      let isNew = discoveredServiceIds[service.key] == nil
      discoveredServiceIds[service.key] = serviceId
      discoveredServices[serviceId] = result.endpoint
      if isNew {
        sendEvent("onServiceFound", [
          "serviceId": serviceId,
          "name": service.name,
          "type": service.type
        ])
      }
    }

    let lostKeys = discoveredServiceIds.keys.filter { !activeKeys.contains($0) }
    for key in lostKeys {
      guard let serviceId = discoveredServiceIds.removeValue(forKey: key) else { continue }
      discoveredServices.removeValue(forKey: serviceId)
      sendEvent("onServiceLost", ["serviceId": serviceId])
    }
  }

  private func connect(endpoint: NWEndpoint, promise: Promise) {
    guard !destroyed else {
      promise.reject("ERR_CONNECTION_FAILED", "The socket module is closed")
      return
    }
    let connection = NWConnection(to: endpoint, using: tcpParameters())
    let managed = addConnection(connection, incoming: false, promise: promise)
    let timeout = DispatchWorkItem { [weak self, weak managed] in
      guard let self, let managed, !managed.opened, !managed.closed else { return }
      managed.connectPromise?.reject("ERR_CONNECTION_FAILED", "Connection timed out")
      managed.connectPromise = nil
      self.closeConnection(managed, reason: "connection_error", emit: false)
    }
    managed.timeoutWorkItem = timeout
    networkQueue.asyncAfter(deadline: .now() + connectTimeout, execute: timeout)
  }

  @discardableResult
  private func addConnection(_ connection: NWConnection, incoming: Bool, promise: Promise?) -> ManagedConnection {
    let managed = ManagedConnection(id: UUID().uuidString, connection: connection, incoming: incoming, promise: promise)
    connections[managed.id] = managed
    connection.stateUpdateHandler = { [weak self, weak managed] state in
      guard let self, let managed else { return }
      self.networkQueue.async {
        guard self.connections[managed.id] === managed, !managed.closed else { return }
        switch state {
        case .ready:
          guard !managed.opened else { return }
          managed.opened = true
          managed.timeoutWorkItem?.cancel()
          managed.timeoutWorkItem = nil
          let info = self.connectionInfo(managed)
          self.sendEvent("onConnectionOpened", info)
          managed.connectPromise?.resolve(info)
          managed.connectPromise = nil
          self.receive(managed)
        case .failed(let error):
          let message = self.networkErrorMessage(error, endpoint: managed.connection.endpoint)
          managed.connectPromise?.reject("ERR_CONNECTION_FAILED", message)
          managed.connectPromise = nil
          self.closeConnection(
            managed,
            reason: "connection_error",
            message: message,
            emit: managed.opened
          )
        case .cancelled:
          self.closeConnection(managed, reason: "remote_close", emit: managed.opened)
        default:
          break
        }
      }
    }
    connection.start(queue: networkQueue)
    return managed
  }

  private func receive(_ managed: ManagedConnection) {
    guard !managed.receiving, !managed.closed else { return }
    managed.receiving = true

    func receiveNext() {
      managed.connection.receive(minimumIncompleteLength: 1, maximumLength: 8 * 1024) { [weak self, weak managed] data, _, isComplete, error in
        guard let self, let managed else { return }
        self.networkQueue.async {
          guard self.connections[managed.id] === managed, !managed.closed else { return }
          if let data, !data.isEmpty {
            self.sendEvent("onMessage", ["connectionId": managed.id, "data": data])
          }
          if let error {
            self.closeConnection(managed, reason: "connection_error", message: error.localizedDescription)
          } else if isComplete {
            self.closeConnection(managed, reason: "remote_close")
          } else {
            receiveNext()
          }
        }
      }
    }

    receiveNext()
  }

  private func send(connectionId: String, data: Data, promise: Promise) {
    guard let managed = connections[connectionId], managed.opened, !managed.closed else {
      promise.reject("ERR_CONNECTION_NOT_FOUND", "Connection '\(connectionId)' was not found")
      return
    }
    managed.connection.send(content: data, completion: .contentProcessed { [weak self, weak managed] error in
      guard let self, let managed else { return }
      self.networkQueue.async {
        if let error {
          self.closeConnection(managed, reason: "connection_error", message: error.localizedDescription)
          promise.reject("ERR_SEND_FAILED", error.localizedDescription)
        } else {
          promise.resolve()
        }
      }
    })
  }

  private func broadcast(data: Data, promise: Promise) {
    let activeConnections = connections.values.filter { $0.opened && !$0.closed }
    guard !activeConnections.isEmpty else {
      promise.resolve()
      return
    }

    var remaining = activeConnections.count
    var firstError: NWError?
    for managed in activeConnections {
      managed.connection.send(content: data, completion: .contentProcessed { [weak self, weak managed] error in
        guard let self else { return }
        self.networkQueue.async {
          if let error {
            firstError = firstError ?? error
            if let managed {
              self.closeConnection(managed, reason: "connection_error", message: error.localizedDescription)
            }
          }
          remaining -= 1
          if remaining == 0 {
            if let firstError {
              promise.reject("ERR_SEND_FAILED", firstError.localizedDescription)
            } else {
              promise.resolve()
            }
          }
        }
      })
    }
  }

  private func closeConnection(
    _ managed: ManagedConnection,
    reason: String,
    message: String? = nil,
    emit: Bool = true
  ) {
    guard connections[managed.id] === managed, !managed.closed else { return }
    managed.closed = true
    managed.timeoutWorkItem?.cancel()
    managed.timeoutWorkItem = nil
    connections.removeValue(forKey: managed.id)
    managed.connection.stateUpdateHandler = nil
    managed.connection.cancel()
    if emit && !destroyed {
      let payload: [String: Any?] = [
        "connectionId": managed.id,
        "reason": reason,
        "message": message
      ]
      sendEvent("onConnectionClosed", payload)
    }
  }

  private func connectionInfo(_ managed: ManagedConnection) -> [String: Any?] {
    var address: String?
    var port = 0
    switch managed.connection.endpoint {
    case .hostPort(let host, let endpointPort):
      address = "\(host)"
      port = Int(endpointPort.rawValue)
    case .service(let name, _, _, _):
      address = name
    default:
      break
    }
    return [
      "connectionId": managed.id,
      "remoteAddress": address,
      "remotePort": port,
      "incoming": managed.incoming
    ]
  }

  private func serviceDetails(_ endpoint: NWEndpoint) -> (key: String, name: String, type: String)? {
    guard case .service(let name, let type, let domain, let interface) = endpoint else { return nil }
    let key = "\(name)\u{0}\(type)\u{0}\(domain)\u{0}\(String(describing: interface))"
    return (key, name, type.hasSuffix(".") ? type : "\(type).")
  }

  private func normalizedServiceType(_ serviceType: String) -> String {
    serviceType.hasSuffix(".") ? String(serviceType.dropLast()) : serviceType
  }

  private func networkErrorMessage(_ error: NWError, endpoint: NWEndpoint) -> String {
    let reason: String
    switch error {
    case .posix(let code):
      reason = "POSIX \(code.rawValue) (\(code))"
    case .dns(let code):
      reason = "DNS \(code)"
    case .tls(let status):
      reason = "TLS \(status)"
    case .wifiAware(let error):
      reason = "Wi-Fi Aware \(error)"
    @unknown default:
      reason = String(describing: error)
    }
    return "Could not connect to \(endpoint): \(reason)"
  }

  private func tcpParameters() -> NWParameters {
    let parameters = NWParameters.tcp
    parameters.includePeerToPeer = true
    parameters.allowLocalEndpointReuse = true
    return parameters
  }

  private func emitError(code: String, message: String, operation: String) {
    guard !destroyed else { return }
    sendEvent("onError", ["code": code, "message": message, "operation": operation])
  }
}
