package com.opengamesonline.expolansockets

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

private const val TIMEOUT_SECONDS = 5L

@RunWith(AndroidJUnit4::class)
class TcpManagerInstrumentedTest {
  private val managers = CopyOnWriteArrayList<TcpManager>()

  @After
  fun tearDown() {
    managers.forEach { it.close() }
  }

  @Test
  fun serverStartsStopsAndRestarts() {
    val manager = manager(RecordingListener())
    val first = start(manager)

    Socket(InetAddress.getLoopbackAddress(), first.port).use { assertTrue(it.isConnected) }
    manager.stopServer(first)
    assertConnectionRefused(first.port)

    val second = start(manager)
    Socket(InetAddress.getLoopbackAddress(), second.port).use { assertTrue(it.isConnected) }
    manager.stopServer(second)
    assertConnectionRefused(second.port)
  }

  @Test
  fun clientConnectsAndDisconnectsWithExpectedReasons() {
    val serverListener = RecordingListener()
    val clientListener = RecordingListener()
    val serverManager = manager(serverListener)
    val clientManager = manager(clientListener)
    val server = start(serverManager)

    val outgoing = connect(clientManager, server.port)
    val incoming = serverListener.awaitOpened()
    val openedBeforeCallback = clientListener.opened.poll()

    assertNotNull(openedBeforeCallback)
    assertFalse(outgoing.incoming)
    assertTrue(incoming.incoming)
    clientManager.disconnect(outgoing.connectionId)

    assertEquals(TcpCloseReason.LOCAL_CLOSE, clientListener.awaitClosed().reason)
    assertEquals(TcpCloseReason.REMOTE_CLOSE, serverListener.awaitClosed().reason)
  }

  @Test
  fun sendsDataInBothDirections() {
    val pair = connectedPair()
    val request = "client-to-server".toByteArray()
    val response = "server-to-client".toByteArray()

    pair.clientManager.send(pair.outgoing.connectionId, request)
    val incomingMessage = pair.serverListener.awaitMessage(request.size)
    assertArrayEquals(request, incomingMessage.data)

    pair.serverManager.send(incomingMessage.connectionId, response)
    assertArrayEquals(response, pair.clientListener.awaitMessage(response.size).data)
  }

  @Test
  fun broadcastsToMultipleClients() {
    val serverListener = RecordingListener()
    val serverManager = manager(serverListener)
    val server = start(serverManager)
    val clients = (1..3).map {
      val listener = RecordingListener()
      val clientManager = manager(listener)
      val outgoing = connect(clientManager, server.port)
      serverListener.awaitOpened()
      Triple(clientManager, listener, outgoing)
    }

    val firstPayload = "broadcast-one".toByteArray()
    serverManager.broadcast(firstPayload)
    clients.forEach { (_, listener) ->
      assertArrayEquals(firstPayload, listener.awaitMessage(firstPayload.size).data)
    }

    clients.first().first.disconnect(clients.first().third.connectionId)
    clients.first().second.awaitClosed()
    serverListener.awaitClosed()
    val secondPayload = "broadcast-two".toByteArray()
    serverManager.broadcast(secondPayload)
    clients.drop(1).forEach { (_, listener) ->
      assertArrayEquals(secondPayload, listener.awaitMessage(secondPayload.size).data)
    }
  }

  @Test
  fun repeatedServerAndConnectionCyclesDoNotLeakState() {
    val serverListener = RecordingListener()
    val clientListener = RecordingListener()
    val serverManager = manager(serverListener)
    val clientManager = manager(clientListener)

    repeat(10) { cycle ->
      val server = start(serverManager)
      val outgoing = connect(clientManager, server.port)
      serverListener.awaitOpened()
      val payload = "cycle-$cycle".toByteArray()
      clientManager.send(outgoing.connectionId, payload)
      assertArrayEquals(payload, serverListener.awaitMessage(payload.size).data)
      clientManager.disconnect(outgoing.connectionId)
      clientListener.awaitClosed()
      serverListener.awaitClosed()
      serverManager.stopServer(server)
      assertConnectionRefused(server.port)
    }
  }

  @Test
  fun closeReleasesListenerAndAllSocketsAndIsIdempotent() {
    val pair = connectedPair()
    pair.serverManager.close()
    pair.serverManager.close()

    val clientClose = pair.clientListener.awaitClosed()
    assertTrue(clientClose.reason == TcpCloseReason.REMOTE_CLOSE || clientClose.reason == TcpCloseReason.CONNECTION_ERROR)
    assertConnectionRefused(pair.server.port)
  }

  @Test
  fun cleanupFailuresDoNotMaskResultsOrKeepStaleConnections() {
    val serverFactoryCalls = AtomicInteger()
    val serverListener = RecordingListener()
    val serverManager = manager(
      serverListener,
      serverSocketFactory = {
        if (serverFactoryCalls.getAndIncrement() == 0) ThrowingCloseServerSocket() else ServerSocket(0)
      }
    )
    val first = start(serverManager)
    serverManager.stopServer(first)
    val second = start(serverManager)
    assertTrue(second.port > 0)

    val failingManager = manager(
      RecordingListener(),
      clientSocketFactory = { ConnectAndCloseFailSocket() }
    )
    val failure = connectResult(failingManager, second.port).exceptionOrNull()
    assertTrue(failure is TcpException)
    assertEquals("ERR_CONNECTION_FAILED", (failure as TcpException).code)
    assertTrue(failure.cause?.message?.contains("connect failed") == true)

    val throwingListener = RecordingListener()
    val throwingManager = manager(
      throwingListener,
      clientSocketFactory = { ThrowingCloseSocket() }
    )
    val connection = connect(throwingManager, second.port)
    serverListener.awaitOpened()
    throwingManager.disconnect(connection.connectionId)
    assertEquals(TcpCloseReason.LOCAL_CLOSE, throwingListener.awaitClosed().reason)
    val sendFailure = runCatching { throwingManager.send(connection.connectionId, byteArrayOf(1)) }.exceptionOrNull()
    assertEquals("ERR_CONNECTION_NOT_FOUND", (sendFailure as TcpException).code)
  }

  private fun connectedPair(): ConnectedPair {
    val serverListener = RecordingListener()
    val clientListener = RecordingListener()
    val serverManager = manager(serverListener)
    val clientManager = manager(clientListener)
    val server = start(serverManager)
    val outgoing = connect(clientManager, server.port)
    serverListener.awaitOpened()
    clientListener.opened.poll()
    return ConnectedPair(serverManager, clientManager, serverListener, clientListener, server, outgoing)
  }

  private fun manager(
    listener: RecordingListener,
    serverSocketFactory: () -> ServerSocket = { ServerSocket(0) },
    clientSocketFactory: () -> Socket = { Socket() }
  ): TcpManager = TcpManager(
    listener = listener,
    serverSocketFactory = serverSocketFactory,
    clientSocketFactory = clientSocketFactory
  ).also { managers += it }

  private fun start(manager: TcpManager): TcpServer {
    val results = LinkedBlockingQueue<Result<TcpServer>>()
    manager.startServer(results::offer)
    return requireNotNull(results.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "Timed out starting server" }.getOrThrow()
  }

  private fun connect(manager: TcpManager, port: Int): TcpConnectionInfo =
    connectResult(manager, port).getOrThrow()

  private fun connectResult(manager: TcpManager, port: Int): Result<TcpConnectionInfo> {
    val results = LinkedBlockingQueue<Result<TcpConnectionInfo>>()
    manager.connect(InetAddress.getLoopbackAddress(), port, results::offer)
    return requireNotNull(results.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "Timed out connecting client" }
  }

  private fun assertConnectionRefused(port: Int) {
    repeat(5) {
      val socket = Socket()
      val failure = runCatching {
        socket.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), port), 300)
      }.exceptionOrNull()
      socket.close()
      if (failure != null) return
      Thread.sleep(20)
    }
    throw AssertionError("Expected port $port to reject connections")
  }
}

private data class ConnectedPair(
  val serverManager: TcpManager,
  val clientManager: TcpManager,
  val serverListener: RecordingListener,
  val clientListener: RecordingListener,
  val server: TcpServer,
  val outgoing: TcpConnectionInfo
)

private data class MessageRecord(val connectionId: String, val data: ByteArray)
private data class CloseRecord(val connectionId: String, val reason: TcpCloseReason, val message: String?)

private class RecordingListener : TcpManagerListener {
  val opened = LinkedBlockingQueue<TcpConnectionInfo>()
  private val messages = LinkedBlockingQueue<MessageRecord>()
  private val closed = LinkedBlockingQueue<CloseRecord>()
  val errors = LinkedBlockingQueue<Pair<String, String>>()

  override fun onConnectionOpened(info: TcpConnectionInfo) {
    opened.offer(info)
  }

  override fun onMessage(connectionId: String, data: ByteArray) {
    messages.offer(MessageRecord(connectionId, data))
  }

  override fun onConnectionClosed(connectionId: String, reason: TcpCloseReason, message: String?) {
    closed.offer(CloseRecord(connectionId, reason, message))
  }

  override fun onServerError(code: String, message: String) {
    errors.offer(code to message)
  }

  fun awaitOpened(): TcpConnectionInfo =
    requireNotNull(opened.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "Timed out waiting for connection" }

  fun awaitClosed(): CloseRecord =
    requireNotNull(closed.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "Timed out waiting for close" }

  fun awaitMessage(expectedBytes: Int): MessageRecord {
    var connectionId: String? = null
    val data = ArrayList<Byte>()
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TIMEOUT_SECONDS)
    while (data.size < expectedBytes) {
      val remaining = deadline - System.nanoTime()
      if (remaining <= 0) break
      val next = messages.poll(remaining, TimeUnit.NANOSECONDS) ?: break
      connectionId = connectionId ?: next.connectionId
      assertEquals(connectionId, next.connectionId)
      next.data.forEach(data::add)
    }
    assertEquals("Timed out waiting for message bytes", expectedBytes, data.size)
    return MessageRecord(requireNotNull(connectionId), data.toByteArray())
  }
}

private class ThrowingCloseServerSocket : ServerSocket(0) {
  override fun close() {
    super.close()
    throw IOException("server close failed")
  }
}

private class ThrowingCloseSocket : Socket() {
  override fun close() {
    super.close()
    throw IOException("socket close failed")
  }
}

private class ConnectAndCloseFailSocket : Socket() {
  override fun connect(endpoint: SocketAddress, timeout: Int) {
    throw IOException("connect failed")
  }

  override fun close() {
    throw IOException("close failed")
  }
}
