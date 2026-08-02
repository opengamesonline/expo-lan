package com.opengamesonline.expolansockets

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal enum class TcpCloseReason(val value: String) {
  LOCAL_CLOSE("local_close"),
  REMOTE_CLOSE("remote_close"),
  SERVER_STOPPED("server_stopped"),
  CONNECTION_ERROR("connection_error")
}

internal data class TcpConnectionInfo(
  val connectionId: String,
  val remoteAddress: String?,
  val remotePort: Int,
  val incoming: Boolean
)

internal class TcpServer internal constructor(
  val port: Int,
  internal val generation: Long
)

internal class TcpException(
  val code: String,
  message: String,
  cause: Throwable? = null
) : Exception(message, cause)

internal interface TcpManagerListener {
  fun onConnectionOpened(info: TcpConnectionInfo)
  fun onMessage(connectionId: String, data: ByteArray)
  fun onConnectionClosed(connectionId: String, reason: TcpCloseReason, message: String?)
  fun onServerError(code: String, message: String)
}

private class ManagedConnection(
  val info: TcpConnectionInfo,
  val socket: Socket,
  val serverGeneration: Long?
) {
  val writeLock = Any()
  val closed = AtomicBoolean(false)
}

private data class ManagedServer(
  val handle: TcpServer,
  val socket: ServerSocket
)

internal class TcpManager(
  private val listener: TcpManagerListener,
  private val serverSocketFactory: () -> ServerSocket = { ServerSocket(0) },
  private val clientSocketFactory: () -> Socket = { Socket() },
  private val idFactory: () -> String = { UUID.randomUUID().toString() },
  private val maxConnections: Int = 8,
  private val connectTimeoutMs: Int = 10_000
) : AutoCloseable {
  private val stateLock = Any()
  private val executor = Executors.newCachedThreadPool()
  private val connections = ConcurrentHashMap<String, ManagedConnection>()
  private val generation = AtomicLong()
  private val destroyed = AtomicBoolean(false)
  private var starting = false
  private var server: ManagedServer? = null

  fun startServer(callback: (Result<TcpServer>) -> Unit) {
    synchronized(stateLock) {
      if (destroyed.get()) {
        callback(Result.failure(TcpException("ERR_SERVER_START", "The TCP manager is closed")))
        return
      }
      if (starting || server != null) {
        callback(Result.failure(TcpException("ERR_SERVER_ALREADY_RUNNING", "A server is already running")))
        return
      }
      starting = true
    }

    executor.execute {
      val socket = try {
        serverSocketFactory()
      } catch (error: Exception) {
        synchronized(stateLock) { starting = false }
        callback(Result.failure(TcpException("ERR_SERVER_START", error.message ?: "Could not start server", error)))
        return@execute
      }

      val managed = synchronized(stateLock) {
        starting = false
        if (destroyed.get() || server != null) {
          closeQuietly(socket)
          null
        } else {
          ManagedServer(TcpServer(socket.localPort, generation.incrementAndGet()), socket).also { server = it }
        }
      }
      if (managed == null) {
        callback(Result.failure(TcpException("ERR_SERVER_START", "The server cannot be started")))
        return@execute
      }

      executor.execute { acceptConnections(managed) }
      callback(Result.success(managed.handle))
    }
  }

  fun stopServer(handle: TcpServer? = null) {
    val stopped = synchronized(stateLock) {
      val current = server
      if (current == null || (handle != null && current.handle.generation != handle.generation)) null
      else current.also { server = null }
    } ?: return

    closeQuietly(stopped.socket)
    connections.values
      .filter { it.serverGeneration == stopped.handle.generation }
      .forEach { closeConnection(it, TcpCloseReason.SERVER_STOPPED) }
  }

  fun connect(host: String, port: Int, callback: (Result<TcpConnectionInfo>) -> Unit) {
    executor.execute {
      val address = try {
        InetAddress.getByName(host)
      } catch (error: Exception) {
        callback(Result.failure(TcpException("ERR_CONNECTION_FAILED", error.message ?: "Could not resolve host", error)))
        return@execute
      }
      connectBlocking(address, port, callback)
    }
  }

  fun connect(address: InetAddress, port: Int, callback: (Result<TcpConnectionInfo>) -> Unit) {
    executor.execute { connectBlocking(address, port, callback) }
  }

  fun send(connectionId: String, data: ByteArray) {
    val connection = connections[connectionId]
      ?: throw TcpException("ERR_CONNECTION_NOT_FOUND", "Connection '$connectionId' was not found")
    write(connection, data)
  }

  fun broadcast(data: ByteArray) {
    connections.values.forEach { connection -> write(connection, data) }
  }

  fun disconnect(connectionId: String) {
    connections[connectionId]?.let { closeConnection(it, TcpCloseReason.LOCAL_CLOSE) }
  }

  override fun close() {
    if (!destroyed.compareAndSet(false, true)) return
    stopServer()
    connections.keys.toTypedArray().forEach { connectionId ->
      connections[connectionId]?.let { closeConnection(it, TcpCloseReason.LOCAL_CLOSE, emit = false) }
    }
    executor.shutdownNow()
  }

  private fun connectBlocking(
    address: InetAddress,
    port: Int,
    callback: (Result<TcpConnectionInfo>) -> Unit
  ) {
    if (port !in 1..65535) {
      callback(Result.failure(TcpException("ERR_INVALID_PORT", "Port must be between 1 and 65535")))
      return
    }
    if (destroyed.get()) {
      callback(Result.failure(TcpException("ERR_CONNECTION_FAILED", "The TCP manager is closed")))
      return
    }

    val socket = try {
      clientSocketFactory()
    } catch (error: Exception) {
      callback(Result.failure(TcpException("ERR_CONNECTION_FAILED", error.message ?: "Could not create socket", error)))
      return
    }
    try {
      socket.connect(InetSocketAddress(address, port), connectTimeoutMs)
      callback(Result.success(addConnection(socket, false, null).info))
    } catch (error: Exception) {
      closeQuietly(socket)
      callback(Result.failure(TcpException("ERR_CONNECTION_FAILED", error.message ?: "Could not connect", error)))
    }
  }

  private fun acceptConnections(server: ManagedServer) {
    while (!server.socket.isClosed && !destroyed.get()) {
      try {
        val socket = server.socket.accept()
        if (connections.size >= maxConnections) {
          closeQuietly(socket)
          continue
        }
        try {
          addConnection(socket, true, server.handle.generation)
        } catch (error: Exception) {
          closeQuietly(socket)
          if (!destroyed.get()) {
            listener.onServerError("ERR_SERVER_ACCEPT", error.message ?: "Could not initialize connection")
          }
        }
      } catch (error: SocketException) {
        if (!server.socket.isClosed && !destroyed.get()) {
          listener.onServerError("ERR_SERVER_ACCEPT", error.message ?: "Accept failed")
        }
        return
      } catch (error: Exception) {
        if (!server.socket.isClosed && !destroyed.get()) {
          listener.onServerError("ERR_SERVER_ACCEPT", error.message ?: "Accept failed")
        }
      }
    }
  }

  private fun addConnection(socket: Socket, incoming: Boolean, serverGeneration: Long?): ManagedConnection {
    socket.tcpNoDelay = true
    val info = TcpConnectionInfo(
      connectionId = idFactory(),
      remoteAddress = socket.inetAddress?.hostAddress,
      remotePort = socket.port,
      incoming = incoming
    )
    val connection = ManagedConnection(info, socket, serverGeneration)
    val accepted = synchronized(stateLock) {
      val activeGeneration = server?.handle?.generation
      if (destroyed.get() || (serverGeneration != null && activeGeneration != serverGeneration)) {
        false
      } else {
        connections[info.connectionId] = connection
        true
      }
    }
    if (!accepted) {
      closeQuietly(socket)
      throw TcpException("ERR_CONNECTION_FAILED", "The TCP manager is closed")
    }
    try {
      listener.onConnectionOpened(info)
      executor.execute { readConnection(connection) }
    } catch (error: Exception) {
      connections.remove(info.connectionId)
      closeQuietly(socket)
      throw error
    }
    return connection
  }

  private fun readConnection(connection: ManagedConnection) {
    val buffer = ByteArray(8 * 1024)
    try {
      val input = connection.socket.getInputStream()
      while (!connection.closed.get()) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) listener.onMessage(connection.info.connectionId, buffer.copyOf(count))
      }
      closeConnection(connection, TcpCloseReason.REMOTE_CLOSE)
    } catch (error: Exception) {
      if (!connection.closed.get()) {
        closeConnection(connection, TcpCloseReason.CONNECTION_ERROR, error.message)
      }
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
      closeConnection(connection, TcpCloseReason.CONNECTION_ERROR, error.message)
      throw TcpException("ERR_SEND_FAILED", error.message ?: "Could not send data", error)
    }
  }

  private fun closeConnection(
    connection: ManagedConnection,
    reason: TcpCloseReason,
    message: String? = null,
    emit: Boolean = true
  ) {
    if (!connection.closed.compareAndSet(false, true)) return
    connections.remove(connection.info.connectionId)
    closeQuietly(connection.socket)
    if (emit && !destroyed.get()) {
      listener.onConnectionClosed(connection.info.connectionId, reason, message)
    }
  }

  private fun closeQuietly(socket: Socket) {
    try {
      socket.close()
    } catch (_: Exception) {
      // Cleanup must not replace the operation's primary result.
    }
  }

  private fun closeQuietly(socket: ServerSocket) {
    try {
      socket.close()
    } catch (_: Exception) {
      // Cleanup must not replace the operation's primary result.
    }
  }
}
