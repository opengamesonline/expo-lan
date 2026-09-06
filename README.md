# Expo LAN

Native LAN service discovery, TCP transport, and host-authoritative multiplayer sessions for Expo applications.

> [!CAUTION]
> This is alpha, AI-generated software. APIs may change or break at any time. It is not ready for production use.

## Packages

- `@opengamesonline/expo-lan-sockets` provides native LAN service discovery and TCP servers, clients, and events. Android uses `NsdManager`, `ServerSocket`, and `Socket`; iOS uses Network.framework's `NWListener`, `NWBrowser`, and `NWConnection`.
- `@opengamesonline/expo-lan-multiplayer` adds newline-delimited JSON framing and host-authoritative game sessions on top of the socket package.

Both packages are currently developed and consumed from this repository. The canonical example uses local `file:` dependencies rather than packages installed from npm.

The tested example stack is Expo SDK 57.0.9, React Native 0.86.2, and React 19.2.3.

## Repository Layout

- `expo-lan-sockets/`: Expo native module and TypeScript socket API.
- `expo-lan-multiplayer/`: TypeScript multiplayer session layer.
- `expo-lan-sockets/@opengamesonline/expo-lan-sockets-example/`: canonical 3x3 shared-tile example and emulator bridge tooling.

## How Multiplayer Works

The multiplayer layer supports one active table per manager, multiple clients, app-defined participant and lobby metadata, create/join/leave flows, generic game events, repeat rounds, reconnection, and best-effort host migration.

While the game browser is open, the multiplayer package maintains one idle watcher TCP connection to each available lobby. Watchers are not participants and send no periodic traffic. They receive live, opaque lobby metadata so applications can show their own occupancy and capacity model before joining.

Starting a game closes its watcher connections, so that game disappears from `LanMultiplayer` browser lists immediately. New watchers and participants are rejected while the phase is `started`. The host can later call `returnToLobby()` to clear round state and reopen the same connected session for another round.

### Generic Lobby Policy

`@opengamesonline/expo-lan-multiplayer` owns network authority and host/client session roles, but it does not assign game-specific roles or capacity rules. Applications provide JSON-serializable participant metadata, lobby metadata, authoritative state, and game events.

`createGame` accepts application callbacks that:

- validate a candidate against the current participant roster with `validateJoin`;
- validate the roster and connected-presence set before starting with `validateStart`;
- create authoritative state at start time with `createInitialState`;
- derive discovery metadata from the reserved roster and connected-presence set with `getLobbyMetadata`; and
- reduce an event with the connection-bound participant identity and an `authoritativeHost` context using `reduceEvent`.

The host is always the network authority but may have any application-defined participant metadata. For example, a card game can mark the host as a spectator, exclude that participant from its player roster in `createInitialState`, and reject spectator commands in `reduceEvent`. The package does not interpret role names, player limits, turn order, or game rules.

Unexpected disconnects retain a participant's ID, slot, metadata, and host-order position. `SessionSnapshot.participants` is this reserved roster; `connectedParticipantIds` reports current presence separately. A lobby host can remove an abandoned reservation with `removeDisconnectedParticipant()`.

Hosts can call `refreshLobbyMetadata()` after changing application-owned lobby configuration. After a round, `returnToLobby()` clears authoritative round state, republishes lobby metadata, and keeps connected participants in the session.

### Recovery And Host Migration

Each accepted session receives a table ID, authority term, deterministic host order, and table-local resume tokens. A reconnect presents its saved participant ID and token, keeps the same participant identity, and receives the current authoritative recovery snapshot.

Applications can persist `session.exportRecoveryState()`, recreate a disconnected session with `multiplayer.restoreGame(...)`, and call `multiplayer.recoverGame(...)`. Recovery first looks for the table's current authority. If none is available, candidates wait according to host order and the next available participant advertises a replacement authority with an incremented term. A returning former host demotes to client when it discovers the winning replacement authority.

Recovery is application-orchestrated. The package provides persistence, suspension, restoration, recovery, cancellation, and authority-monitoring primitives, but the application decides when to call them. Sevens persists recovery state and invokes recovery across backgrounding and process restarts.

The canonical tile example demonstrates in-memory recovery: it suspends on background, reconnects on foreground or unexpected transport loss, promotes the next host-order candidate, and converges an old host onto a higher authority. It does not persist credentials across process termination; use `exportRecoveryState()` and `restoreGame(...)` for that application-owned workflow.

## Current Limitations

- Networking and gameplay do not run in the background. Applications should export recovery state, suspend the session, and recover after returning to the foreground.
- Host migration is best effort rather than a quorum consensus protocol. A network partition can temporarily create competing authorities. Authority terms and host order select the winning branch when discovery converges, so events committed only on a losing branch can roll back.
- Explicit host closure sends `tableClosed` and ends the table instead of triggering migration. Abrupt host loss is recoverable only when another participant retained a sufficiently recent recovery snapshot.
- A recovery attempt times out after 45 seconds. Promotion starts after five seconds and is staggered by three seconds per host-order candidate, so unusually large rosters may need another recovery attempt before a late candidate can promote.
- Traffic is not authenticated or encrypted. Participant identity is session-local, and the host is trusted as the authority. Use the packages only on trusted local networks unless the application adds its own security layer.
- Resume tokens are lightweight bearer credentials generated for trusted LAN play, not cryptographic authentication. Recovery snapshots replicate the complete token registry so any participant can become host; applications should persist them as sensitive data.
- Discovery and connections are LAN-only. There is no internet matchmaking, relay service, NAT traversal, or support for routers that block multicast DNS or isolate Wi-Fi clients.
- The native socket module supports one advertised server and one discovery operation at a time. The module is a process-wide singleton, so prefer one long-lived `LanMultiplayer` manager per app. Each manager supports one active game session at a time.
- Incoming acceptance stops when the native module already tracks 32 connections. Outgoing connections are not directly capped, but they count in that total and reduce incoming capacity. Host-side watchers and participants also consume tracked connections.
- Outbound multiplayer messages are newline-delimited JSON and limited to 65,536 encoded bytes. The current receiver limits its decoded buffer to 65,536 characters. Types are not comprehensive runtime validation: hosts must validate untrusted participant metadata and events, and clients must treat host state and lobby metadata as untrusted input.
- Advertised game names are trimmed to 20 characters and participant names to 24 characters. Empty names fall back to `LAN Game` and `Participant`.
- The packages require a native development or production build and do not run in Expo Go. Web imports expose all capabilities as `false`, and network operations throw an unsupported error.
- Bonjour and NSD timing depends on the platform and network. The example includes a manual **Refresh** action because Android emulators can delay discovering a game created after browsing has started.
- Emulator networking does not fully represent a physical LAN. The development bridge supports Android-emulator hosts connecting to an iOS Simulator, but it is test tooling rather than production functionality.

## App Configuration

The socket package contains native code, so create an Expo development or production build after installing it. There is no config plugin that adds the iOS local-network declarations automatically.

Add the following to the consuming app's Expo configuration:

```json
{
  "expo": {
    "ios": {
      "infoPlist": {
        "NSLocalNetworkUsageDescription": "Discover and connect to multiplayer games on your local network.",
        "NSBonjourServices": ["_expo-lan-game._tcp"]
      }
    }
  }
}
```

Android automatically merges the module's `INTERNET` and `CHANGE_WIFI_MULTICAST_STATE` permissions into the consuming app.

The Bonjour entry above is the multiplayer package's service type. Apps using custom service types through the low-level socket API must also list those types in `NSBonjourServices`.

## Multiplayer API

Create one long-lived manager and subscribe to discovery results:

```ts
import {
  type CreateGameOptions,
  type DiscoveredGame,
  LanMultiplayer,
} from '@opengamesonline/expo-lan-multiplayer';

type ParticipantMetadata = { role: 'player' | 'spectator' };
type LobbyMetadata = { playerCount: number; maxPlayers: number };
type State = { score: Record<string, number> };
type GameEvent = { type: 'score'; points: number };

const multiplayer = new LanMultiplayer<ParticipantMetadata, LobbyMetadata>();

const unsubscribeGames = multiplayer.subscribeToGames((games) => {
  // Render DiscoveredGame<LobbyMetadata>[] in the lobby browser.
});

await multiplayer.startDiscovery();
await multiplayer.refreshDiscovery(); // Optional manual refresh.
await multiplayer.stopDiscovery();
```

Host a game and reduce client events into authoritative state:

```ts
const hostOptions: CreateGameOptions<
  State,
  GameEvent,
  ParticipantMetadata,
  LobbyMetadata
> = {
  name: 'My Game',
  participantName: 'Host',
  participantMetadata: { role: 'player' },
  validateJoin(_candidate, participants) {
    return participants.length >= 4 ? 'The game is full' : null;
  },
  validateStart(_participants, connectedParticipantIds) {
    return connectedParticipantIds.size < 2 ? 'Two connected players are required' : null;
  },
  createInitialState(participants) {
    return {
      score: Object.fromEntries(participants.map((participant) => [participant.id, 0])),
    };
  },
  getLobbyMetadata(_participants, connectedParticipantIds) {
    return { playerCount: connectedParticipantIds.size, maxPlayers: 4 };
  },
  reduceEvent(state, event, participant, { authoritativeHost }) {
    if (event.type !== 'score' || !Number.isFinite(event.points)) return state;
    // authoritativeHost is true when this event originated on the authority itself.
    return {
      score: {
        ...state.score,
        [participant.id]: (state.score[participant.id] ?? 0) + event.points,
      },
    };
  },
};

const session = await multiplayer.createGame<State, GameEvent>(hostOptions);

const unsubscribeSession = session.subscribe((snapshot) => {
  // Read role, status, phase, state, participants, connectedParticipantIds,
  // tableId, authorityTerm, hostParticipantId, lobbyMetadata, and error.
});

await session.startGame(); // Host only.
await session.sendGameEvent({ type: 'score', points: 1 });
await session.returnToLobby(); // Host only; reuse the session for another round.
```

Join a discovered game:

```ts
async function join(game: DiscoveredGame<LobbyMetadata>) {
  const session = await multiplayer.joinGame<State, GameEvent>({
    service: game,
    participantName: 'Player 2',
    participantMetadata: { role: 'player' },
  });

  return session;
}
```

Call `multiplayer.cancelPendingJoin()` when dismissing a UI with an in-progress join. Call `session.leaveGame()` when leaving a lobby or game, unsubscribe UI listeners, and call `multiplayer.dispose()` when permanently disposing the manager.

Persist and recover a session using application-owned storage:

```ts
const recovery = session.exportRecoveryState();
const selfParticipantId = session.snapshot.self!.id;

// Persist recovery and selfParticipantId as sensitive JSON data.
await multiplayer.suspendSession();
await multiplayer.recoverGame(session, hostOptions); // Recover the in-memory session.

// After a process restart, create a new manager and restore persisted data.
const restoredMultiplayer = new LanMultiplayer<ParticipantMetadata, LobbyMetadata>();

const restored = restoredMultiplayer.restoreGame<State, GameEvent>({
  recovery,
  selfParticipantId,
  hostOptions,
});

const result = await restoredMultiplayer.recoverGame(restored, hostOptions);
// result is 'reconnected' or 'promoted'.
```

Use `cancelRecovery()` when abandoning an in-progress recovery. A connected host can use `startAuthorityMonitoring()` and `hasHigherAuthority(session)` to detect a superior authority after a partition. `dispose({ preserveSession: true })` suspends rather than explicitly leaving before manager teardown.

The ordinary join path retries a connection up to three times with 500 ms delays. Browser watcher acknowledgements time out after two seconds. New joins are rejected while the session phase is `started`.

## Low-Level Socket API

The default export from `@opengamesonline/expo-lan-sockets` exposes:

- `capabilities`: `tcpServer`, `tcpClient`, and `serviceDiscovery` booleans.
- `startServerAsync` and `stopServerAsync`: advertise and manage one TCP server.
- `startDiscoveryAsync` and `stopDiscoveryAsync`: browse one service type.
- `connectAsync` and `connectToServiceAsync`: connect directly or through a discovered service.
- `sendAsync`, `broadcastAsync`, and `disconnectAsync`: manage binary connection traffic.
- `addListener`: subscribe to `onServiceFound`, `onServiceLost`, `onConnectionOpened`, `onMessage`, `onConnectionClosed`, and `onError`.

The low-level API sends and receives `Uint8Array` values. Framing, serialization, and application protocol behavior are the caller's responsibility.

## Prerequisites

- Node.js and npm. The optional Nix shell currently pins Node.js 26 and also provides Bun, Git, jq, pre-commit, and GitHub CLI.
- Android builds: Android SDK Platform 36, Build Tools 35 or newer, Platform Tools, and Java 17 or newer. Android minimum and compile SDK values are inherited from the consuming Expo project.
- iOS builds: macOS, Xcode 26.4 or newer for the tested example, Xcode Command Line Tools, and an iOS 16.4 or newer target or Simulator runtime.
- Multiplayer testing: two emulators, simulators, or USB-debuggable physical devices. Physical devices must be on the same local network for Bonjour/NSD discovery.

The Nix shell provides JavaScript and repository tooling, not Xcode, Java, or the Android SDK:

```zsh
nix develop
```

On macOS, expose the Android SDK if it is not already configured by your shell:

```zsh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
adb devices -l
```

Confirm that Xcode and at least one iOS Simulator are available:

```zsh
xcodebuild -version
xcrun simctl list devices available
```

Install a Simulator runtime from **Xcode > Settings > Components** if the device list is empty.

## Repository Setup

Install and build the packages in dependency order from the repository root:

```zsh
cd expo-lan-sockets
npm install
EXPO_NONINTERACTIVE=1 npm run build

cd ../expo-lan-multiplayer
npm install
npm test

cd ../expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm install
npm run check
npm run test:bridge
```

In an interactive terminal, `expo-lan-sockets` runs `npm run build` in watch mode by default. Set `EXPO_NONINTERACTIVE=1` for the one-shot build shown above.

The example includes `expo-dev-client`; it does not run in Expo Go.

## Run Locally

Start one Metro server from the example directory and leave it running:

```zsh
cd expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm start
```

### Android

In a second terminal, build and install the development client on the first target:

```zsh
cd expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm run android:device -- --no-bundler
```

Select the first emulator or physical device when prompted. Run the same command again and select the second target. Gradle is incremental, so the second installation is substantially faster.

`expo run:android` generates the ignored `android/` project when needed, installs the debug APK, and opens the running Metro URL in the development client.

### iOS Simulator

In a second terminal, build and install the development client on an iOS Simulator:

```zsh
cd expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm run ios -- --device --no-bundler
```

Select an available simulator when prompted. Expo generates the ignored `ios/` project when needed, installs CocoaPods dependencies, boots the selected simulator, builds the app, and opens the running Metro URL in the development client.

For a two-simulator multiplayer test, run the same command again and select a different simulator. You can also open Simulator manually and choose additional devices from **File > Open Simulator**:

```zsh
open -a Simulator
```

After installing the development client, press **Shift + I** in Metro's terminal UI to select and reopen an iOS Simulator without rebuilding the native app.

### Android Host to iOS Simulator Bridge

The Android emulator uses NAT, so an iOS Simulator cannot connect to the emulator address advertised through Bonjour. For an emulator-only cross-platform test, replace `npm start` with the bridge command:

```zsh
cd expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm run bridge
```

The script starts Metro and a sidecar that monitors every running `emulator-*` device from `adb devices`. Emulators can start or stop while the sidecar runs. When an emulator advertises a game, the sidecar matches its Bonjour address to the AVD's guest interfaces, verifies its dynamic port, creates an ADB forward, starts a TCP relay on the Mac, and publishes a labeled Bonjour proxy.

Create the game on an Android emulator, choose **Find games** on iOS, and join the service named `Game name [bridge emulator-5554]`. Do not select the original service because it resolves through the emulator's unreachable NAT path. Press **Ctrl-C** to stop Metro and remove the proxy advertisements, relays, and ADB forwarding rules created by this sidecar.

Services hosted outside connected Android emulators are ignored. The sidecar is development tooling only and requires no special native build. Use regular `npm start` when iOS is hosting or when testing physical devices.

## Development Loop

`metro.config.js` watches the socket and multiplayer package roots and aliases both package names to those roots. Their `react-native` entries resolve to TypeScript source, so changes use Fast Refresh without rebuilding package output.

After changing Kotlin, Swift, a native manifest, native dependencies, or Expo app configuration, reinstall the corresponding native build on each target:

```zsh
npm run android:device -- --no-bundler
npm run ios -- --device --no-bundler
```

Run the local checks separately when changing public package APIs:

```zsh
cd expo-lan-sockets
EXPO_NONINTERACTIVE=1 npm run build
npm run lint

cd ../expo-lan-multiplayer
npm test

cd ../expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm run check
npm run test:bridge
```

The multiplayer tests exercise `GameSession` and protocol framing through an injected in-memory socket transport. They cover participant metadata, connected presence, join/start policy, lobby refresh, repeat rounds, authoritative event identity, reconnection with preserved identity and state, restart restoration, revoked recovery identities, direct host promotion, leaving, heartbeats, and fragmented frames. They do not exercise the complete `LanMultiplayer.recoverGame()` discovery/election loop, real network partitions, competing-authority convergence, native discovery, or real socket integration.

After `expo run:android` has generated the ignored example `android/` project, run the Android native loopback suite with at least one emulator or device connected:

```zsh
npm run test:android:sockets
```

The Android suite exercises server restart, client connect and disconnect, bidirectional binary messages, broadcasts, repeated lifecycle cycles, manager cleanup, and injected socket cleanup failures. It tests the JDK TCP transport directly. There is currently no corresponding automated Swift suite, and Bonjour/NSD discovery remains a physical-device end-to-end concern.

## Testing Multiplayer

1. Open the app on both targets.
2. Choose **Create game** on the first target.
3. Choose **Find games** on the second target.
4. Confirm the advertised player count and capacity, join the game, and verify both players appear in the lobby.
5. Choose **Start game** on the host.
6. Press tiles from both devices and confirm that both boards update.
7. Background a client, return it to the foreground, and confirm it reconnects with the same identity and board state.
8. Background the host for at least five seconds and confirm the next candidate becomes host. Return the old host and confirm it reconnects as a client.
9. Leave the game and confirm the player is removed. Explicitly closing from a connected host ends the table instead of migrating.

Physical devices on the same Wi-Fi network are recommended for final Bonjour/NSD testing. Android emulators may not forward multicast DNS between emulator instances even when both apps and TCP transport work correctly. Use the development bridge when an Android emulator must host for an iOS Simulator.

If a development client cannot connect, confirm Metro is running for this example, the host firewall allows local connections, and the device can reach the host machine's LAN address. Rerunning the platform command reopens the development URL.

## License

MIT
