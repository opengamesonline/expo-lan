package com.opengamesonline.expolansockets

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.net.InetSocketAddress
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private const val MAX_CONNECTIONS = 8
private const val CONNECT_TIMEOUT_MS = 10_000

internal data class ServerOptions(
  @Field val serviceName: String = "Expo LAN Game",
  @Field val serviceType: String = "_expo-lan-game._tcp."
) : Record

private class ManagedConnection(val id: String, val socket: Socket, val incoming: Boolean) {
  val writeLock = Any()
  val closed = AtomicBoolean(false)
}

class ExpoLanSocketsModule : Module() {
  private val stateLock = Any()
  private val executor = Executors.newCachedThreadPool()
  private val connections = ConcurrentHashMap<String, ManagedConnection>()
  private val discoveredServices = ConcurrentHashMap<String, NsdServiceInfo>()
  private val discoveredServiceIds = ConcurrentHashMap<String, String>()

  private var serverSocket: ServerSocket? = null
  private var registrationListener: NsdManager.RegistrationListener? = null
  private var serverStopPromise: Promise? = null
  private var discoveryListener: NsdManager.DiscoveryListener? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private var multicastUsers = 0
  private var destroyed = false

  private val nsdManager: NsdManager
    get() = requireNotNull(appContext.reactContext)
      .getSystemService(Context.NSD_SERVICE) as NsdManager

  override fun definition() = ModuleDefinition {
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
      mapOf(
        "tcpServer" to true,
        "tcpClient" to true,
        "serviceDiscovery" to true
      )
    }

    AsyncFunction("startServerAsync") { options: ServerOptions, promise: Promise ->
      startServer(options, promise)
    }

    AsyncFunction("stopServerAsync") { promise: Promise ->
      stopServer(promise)
    }

    AsyncFunction("startDiscoveryAsync") { serviceType: String, promise: Promise ->
      startDiscovery(serviceType, promise)
    }

    AsyncFunction("stopDiscoveryAsync") { promise: Promise ->
      stopDiscovery(promise)
    }

    AsyncFunction("connectAsync") { host: String, port: Int, promise: Promise ->
      executor.execute { connect(host, port, promise) }
    }

    AsyncFunction("connectToServiceAsync") { serviceId: String, promise: Promise ->
      connectToService(serviceId, promise)
    }

    AsyncFunction("sendAsync") { connectionId: String, data: ByteArray ->
      val connection = connections[connectionId]
        ?: throw LanSocketsException("ERR_CONNECTION_NOT_FOUND", "Connection '$connectionId' was not found")
      write(connection, data)
    }

    AsyncFunction("broadcastAsync") { data: ByteArray ->
      connections.values.forEach { connection -> write(connection, data) }
    }

    AsyncFunction("disconnectAsync") { connectionId: String ->
      connections[connectionId]?.let { closeConnection(it, "local_close") }
    }

    OnDestroy {
      destroyed = true
      stopDiscovery(null)
      stopServer(null)
      executor.shutdownNow()
    }
  }

  private fun startServer(options: ServerOptions, promise: Promise) {
    synchronized(stateLock) {
      if (serverSocket != null) {
        promise.reject("ERR_SERVER_ALREADY_RUNNING", "A server is already running", null)
        return
      }
    }

    executor.execute {
      val server = try {
        ServerSocket(0)
      } catch (error: Exception) {
        promise.reject("ERR_SERVER_START", error.message ?: "Could not start server", error)
        return@execute
      }

      synchronized(stateLock) {
        if (destroyed || serverSocket != null) {
          server.close()
          promise.reject("ERR_SERVER_START", "The server cannot be started", null)
          return@execute
        }
        serverSocket = server
      }
      executor.execute { acceptConnections(server) }
      registerService(server, options, promise)
    }
  }

  private fun registerService(server: ServerSocket, options: ServerOptions, promise: Promise) {
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
        promise.resolve(
          mapOf(
            "port" to server.localPort,
            "serviceName" to serviceInfo.serviceName,
            "serviceType" to options.serviceType
          )
        )
      }

      override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
        synchronized(stateLock) { registrationListener = null }
        releaseMulticast()
        closeServerSocket(server)
        promise.reject("ERR_SERVICE_REGISTRATION", "NSD registration failed ($errorCode)", null)
      }

      override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {
        releaseMulticast()
        val stopPromise = synchronized(stateLock) {
          val pending = serverStopPromise
          serverStopPromise = null
          pending
        }
        stopPromise?.resolve()
      }

      override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
        releaseMulticast()
        val stopPromise = synchronized(stateLock) {
          val pending = serverStopPromise
          serverStopPromise = null
          pending
        }
        if (stopPromise != null) {
          stopPromise.reject("ERR_SERVICE_UNREGISTRATION", "NSD unregistration failed ($errorCode)", null)
        } else {
          emitError("ERR_SERVICE_UNREGISTRATION", "NSD unregistration failed ($errorCode)", "server")
        }
      }
    }

    synchronized(stateLock) { registrationListener = listener }
    acquireMulticast()
    val serviceInfo = NsdServiceInfo().apply {
      serviceName = options.serviceName
      serviceType = options.serviceType
      port = server.localPort
    }

    try {
      nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (error: Exception) {
      synchronized(stateLock) { registrationListener = null }
      releaseMulticast()
      closeServerSocket(server)
      promise.reject("ERR_SERVICE_REGISTRATION", error.message ?: "Could not register service", error)
    }
  }

  private fun stopServer(promise: Promise?) {
    val listener: NsdManager.RegistrationListener?
    val server: ServerSocket?
    synchronized(stateLock) {
      listener = registrationListener
      registrationListener = null
      server = serverSocket
      serverSocket = null
    }

    try {
      server?.close()
    } catch (_: Exception) {
      // Closing an already closed listener is harmless.
    }
    connections.values.filter { it.incoming }.forEach { closeConnection(it, "server_stopped") }

    if (listener == null) {
      promise?.resolve()
      return
    }

    synchronized(stateLock) { serverStopPromise = promise }
    try {
      nsdManager.unregisterService(listener)
    } catch (error: Exception) {
      synchronized(stateLock) { serverStopPromise = null }
      releaseMulticast()
      promise?.reject("ERR_SERVICE_UNREGISTRATION", error.message ?: "Could not unregister service", error)
    }
  }

  private fun acceptConnections(server: ServerSocket) {
    while (!server.isClosed) {
      try {
        val socket = server.accept()
        if (connections.size >= MAX_CONNECTIONS) {
          socket.close()
          continue
        }
        addConnection(socket, true)
      } catch (error: SocketException) {
        if (!server.isClosed) emitError("ERR_SERVER_ACCEPT", error.message ?: "Accept failed", "server")
        return
      } catch (error: Exception) {
        if (!server.isClosed) emitError("ERR_SERVER_ACCEPT", error.message ?: "Accept failed", "server")
      }
    }
  }

  private fun startDiscovery(serviceType: String, promise: Promise) {
    synchronized(stateLock) {
      if (discoveryListener != null) {
        promise.reject("ERR_DISCOVERY_ALREADY_RUNNING", "Service discovery is already running", null)
        return
      }
    }

    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(regType: String) {
        promise.resolve()
      }

      override fun onServiceFound(serviceInfo: NsdServiceInfo) {
        val key = serviceKey(serviceInfo)
        val serviceId = discoveredServiceIds.computeIfAbsent(key) { UUID.randomUUID().toString() }
        discoveredServices[serviceId] = serviceInfo
        sendEvent(
          "onServiceFound",
          mapOf(
            "serviceId" to serviceId,
            "name" to serviceInfo.serviceName,
            "type" to serviceInfo.serviceType
          )
        )
      }

      override fun onServiceLost(serviceInfo: NsdServiceInfo) {
        val serviceId = discoveredServiceIds.remove(serviceKey(serviceInfo)) ?: return
        discoveredServices.remove(serviceId)
        sendEvent("onServiceLost", mapOf("serviceId" to serviceId))
      }

      override fun onDiscoveryStopped(serviceType: String) = Unit

      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        synchronized(stateLock) { discoveryListener = null }
        releaseMulticast()
        promise.reject("ERR_DISCOVERY_START", "NSD discovery failed ($errorCode)", null)
      }

      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
        emitError("ERR_DISCOVERY_STOP", "Stopping NSD discovery failed ($errorCode)", "discovery")
      }
    }

    synchronized(stateLock) { discoveryListener = listener }
    acquireMulticast()
    try {
      nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (error: Exception) {
      synchronized(stateLock) { discoveryListener = null }
      releaseMulticast()
      promise.reject("ERR_DISCOVERY_START", error.message ?: "Could not start discovery", error)
    }
  }

  private fun stopDiscovery(promise: Promise?) {
    val listener = synchronized(stateLock) {
      val current = discoveryListener
      discoveryListener = null
      current
    }
    discoveredServices.clear()
    discoveredServiceIds.clear()
    if (listener == null) {
      promise?.resolve()
      return
    }

    try {
      nsdManager.stopServiceDiscovery(listener)
      releaseMulticast()
      promise?.resolve()
    } catch (error: Exception) {
      releaseMulticast()
      promise?.reject("ERR_DISCOVERY_STOP", error.message ?: "Could not stop discovery", error)
    }
  }

  @Suppress("DEPRECATION")
  private fun connectToService(serviceId: String, promise: Promise) {
    val service = discoveredServices[serviceId]
    if (service == null) {
      promise.reject("ERR_SERVICE_NOT_FOUND", "Service '$serviceId' was not found", null)
      return
    }

    try {
      nsdManager.resolveService(service, object : NsdManager.ResolveListener {
        override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
          val address = serviceInfo.host
          if (address == null) {
            promise.reject("ERR_SERVICE_RESOLVE", "The service has no reachable address", null)
            return
          }
          executor.execute { connect(address, serviceInfo.port, promise) }
        }

        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
          promise.reject("ERR_SERVICE_RESOLVE", "NSD resolution failed ($errorCode)", null)
        }
      })
    } catch (error: Exception) {
      promise.reject("ERR_SERVICE_RESOLVE", error.message ?: "Could not resolve service", error)
    }
  }

  private fun connect(host: String, port: Int, promise: Promise) {
    val address = try {
      InetAddress.getByName(host)
    } catch (error: Exception) {
      promise.reject("ERR_CONNECTION_FAILED", error.message ?: "Could not resolve host", error)
      return
    }
    connect(address, port, promise)
  }

  private fun connect(address: InetAddress, port: Int, promise: Promise) {
    if (port !in 1..65535) {
      promise.reject("ERR_INVALID_PORT", "Port must be between 1 and 65535", null)
      return
    }
    val socket = Socket()
    try {
      socket.connect(InetSocketAddress(address, port), CONNECT_TIMEOUT_MS)
      val connection = addConnection(socket, false)
      promise.resolve(connectionInfo(connection))
    } catch (error: Exception) {
      try {
        socket.close()
      } catch (_: Exception) {
        // Ignore cleanup errors after a failed connection.
      }
      promise.reject("ERR_CONNECTION_FAILED", error.message ?: "Could not connect", error)
    }
  }

  private fun addConnection(socket: Socket, incoming: Boolean): ManagedConnection {
    socket.tcpNoDelay = true
    val connection = ManagedConnection(UUID.randomUUID().toString(), socket, incoming)
    connections[connection.id] = connection
    sendEvent("onConnectionOpened", connectionInfo(connection))
    executor.execute { readConnection(connection) }
    return connection
  }

  private fun readConnection(connection: ManagedConnection) {
    val buffer = ByteArray(8 * 1024)
    try {
      val input = connection.socket.getInputStream()
      while (!connection.closed.get()) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) {
          sendEvent(
            "onMessage",
            mapOf("connectionId" to connection.id, "data" to buffer.copyOf(count))
          )
        }
      }
      closeConnection(connection, "remote_close")
    } catch (error: Exception) {
      if (!connection.closed.get()) closeConnection(connection, "connection_error", error.message)
    }
  }

  private fun write(connection: ManagedConnection, data: ByteArray) {
    try {
      synchronized(connection.writeLock) {
        connection.socket.getOutputStream().apply {
          write(data)
          flush()
        }
      }
    } catch (error: Exception) {
      closeConnection(connection, "connection_error", error.message)
      throw LanSocketsException("ERR_SEND_FAILED", error.message ?: "Could not send data", error)
    }
  }

  private fun closeConnection(connection: ManagedConnection, reason: String, message: String? = null) {
    if (!connection.closed.compareAndSet(false, true)) return
    connections.remove(connection.id)
    try {
      connection.socket.close()
    } catch (_: Exception) {
      // The close event is still valid if the underlying socket was already closed.
    }
    if (!destroyed) {
      sendEvent(
        "onConnectionClosed",
        mapOf("connectionId" to connection.id, "reason" to reason, "message" to message)
      )
    }
  }

  private fun closeServerSocket(server: ServerSocket) {
    synchronized(stateLock) {
      if (serverSocket === server) serverSocket = null
    }
    try {
      server.close()
    } catch (_: Exception) {
      // Ignore cleanup errors while unwinding startup.
    }
  }

  private fun connectionInfo(connection: ManagedConnection): Map<String, Any?> = mapOf(
    "connectionId" to connection.id,
    "remoteAddress" to connection.socket.inetAddress?.hostAddress,
    "remotePort" to connection.socket.port,
    "incoming" to connection.incoming
  )

  private fun serviceKey(serviceInfo: NsdServiceInfo) =
    "${serviceInfo.serviceName}\u0000${serviceInfo.serviceType}"

  private fun acquireMulticast() {
    synchronized(stateLock) {
      multicastUsers += 1
      if (multicastLock?.isHeld == true) return
      val context = appContext.reactContext?.applicationContext ?: return
      val wifiManager = context.getSystemService(Context.WIFI_SERVICE) as WifiManager
      multicastLock = wifiManager.createMulticastLock("ExpoLanSockets").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
  }

  private fun releaseMulticast() {
    synchronized(stateLock) {
      multicastUsers = (multicastUsers - 1).coerceAtLeast(0)
      if (multicastUsers != 0) return
      try {
        if (multicastLock?.isHeld == true) multicastLock?.release()
      } catch (_: Exception) {
        // A lock may already be released during application teardown.
      }
      multicastLock = null
    }
  }

  private fun emitError(code: String, message: String, operation: String) {
    if (!destroyed) sendEvent("onError", mapOf("code" to code, "message" to message, "operation" to operation))
  }
}

private class LanSocketsException(code: String, message: String, cause: Throwable? = null) :
  expo.modules.kotlin.exception.CodedException(code, message, cause)
