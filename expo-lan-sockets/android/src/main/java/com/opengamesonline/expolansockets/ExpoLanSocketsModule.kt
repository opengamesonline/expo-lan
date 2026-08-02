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
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal data class ServerOptions(
  @Field val serviceName: String = "Expo LAN Game",
  @Field val serviceType: String = "_expo-lan-game._tcp."
) : Record

class ExpoLanSocketsModule : Module() {
  private val stateLock = Any()
  private val discoveredServices = ConcurrentHashMap<String, NsdServiceInfo>()
  private val discoveredServiceIds = ConcurrentHashMap<String, String>()
  private val tcpManager = TcpManager(object : TcpManagerListener {
    override fun onConnectionOpened(info: TcpConnectionInfo) {
      sendEvent("onConnectionOpened", connectionInfoMap(info))
    }

    override fun onMessage(connectionId: String, data: ByteArray) {
      sendEvent("onMessage", mapOf("connectionId" to connectionId, "data" to data))
    }

    override fun onConnectionClosed(connectionId: String, reason: TcpCloseReason, message: String?) {
      if (!destroyed) {
        sendEvent(
          "onConnectionClosed",
          mapOf("connectionId" to connectionId, "reason" to reason.value, "message" to message)
        )
      }
    }

    override fun onServerError(code: String, message: String) {
      emitError(code, message, "server")
    }
  })

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
      tcpManager.startServer { result ->
        result.fold(
          onSuccess = { server -> registerService(server, options, promise) },
          onFailure = { error -> rejectTcp(promise, error) }
        )
      }
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
      tcpManager.connect(host, port) { result -> settleConnection(promise, result) }
    }

    AsyncFunction("connectToServiceAsync") { serviceId: String, promise: Promise ->
      connectToService(serviceId, promise)
    }

    AsyncFunction("sendAsync") { connectionId: String, data: ByteArray ->
      try {
        tcpManager.send(connectionId, data)
      } catch (error: TcpException) {
        throw LanSocketsException(error.code, error.message ?: "Could not send data", error)
      }
    }

    AsyncFunction("broadcastAsync") { data: ByteArray ->
      try {
        tcpManager.broadcast(data)
      } catch (error: TcpException) {
        throw LanSocketsException(error.code, error.message ?: "Could not broadcast data", error)
      }
    }

    AsyncFunction("disconnectAsync") { connectionId: String ->
      tcpManager.disconnect(connectionId)
    }

    OnDestroy {
      destroyed = true
      stopDiscovery(null)
      stopServer(null)
      tcpManager.close()
    }
  }

  private fun registerService(server: TcpServer, options: ServerOptions, promise: Promise) {
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
        promise.resolve(
          mapOf(
            "port" to server.port,
            "serviceName" to serviceInfo.serviceName,
            "serviceType" to options.serviceType
          )
        )
      }

      override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
        synchronized(stateLock) { registrationListener = null }
        releaseMulticast()
        tcpManager.stopServer(server)
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
      port = server.port
    }

    try {
      nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (error: Exception) {
      synchronized(stateLock) { registrationListener = null }
      releaseMulticast()
      tcpManager.stopServer(server)
      promise.reject("ERR_SERVICE_REGISTRATION", error.message ?: "Could not register service", error)
    }
  }

  private fun stopServer(promise: Promise?) {
    val listener = synchronized(stateLock) {
      val current = registrationListener
      registrationListener = null
      current
    }
    tcpManager.stopServer()

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
          tcpManager.connect(address, serviceInfo.port) { result -> settleConnection(promise, result) }
        }

        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
          promise.reject("ERR_SERVICE_RESOLVE", "NSD resolution failed ($errorCode)", null)
        }
      })
    } catch (error: Exception) {
      promise.reject("ERR_SERVICE_RESOLVE", error.message ?: "Could not resolve service", error)
    }
  }

  private fun settleConnection(promise: Promise, result: Result<TcpConnectionInfo>) {
    result.fold(
      onSuccess = { info -> promise.resolve(connectionInfoMap(info)) },
      onFailure = { error -> rejectTcp(promise, error) }
    )
  }

  private fun rejectTcp(promise: Promise, error: Throwable) {
    if (error is TcpException) {
      promise.reject(error.code, error.message, error.cause)
    } else {
      promise.reject("ERR_CONNECTION_FAILED", error.message ?: "TCP operation failed", error)
    }
  }

  private fun connectionInfoMap(info: TcpConnectionInfo): Map<String, Any?> = mapOf(
    "connectionId" to info.connectionId,
    "remoteAddress" to info.remoteAddress,
    "remotePort" to info.remotePort,
    "incoming" to info.incoming
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
