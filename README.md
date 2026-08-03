# Expo LAN

Native LAN multiplayer transport and host-authoritative sessions for Expo applications.

## Packages

- `@opengamesonline/expo-lan-sockets` wraps Android `NsdManager`, `ServerSocket`, and `Socket` for native service discovery and TCP transport.
- On iOS, the socket package uses `NWListener`, `NWBrowser`, and `NWConnection` from Network.framework.
- `@opengamesonline/expo-lan-multiplayer` adds message framing and host-authoritative TypeScript game sessions.

The MVP supports one advertised server, one discovery operation, multiple clients, app-defined participant and lobby metadata, create/join/leave flows, and generic game events.

While the game browser is open, the multiplayer package maintains one idle watcher TCP connection to each available lobby. Watchers are not session participants and send no periodic traffic. They receive live, opaque lobby metadata so applications can show their own occupancy and capacity model before joining. Starting or cancelling a game closes its watcher connections, removing the listing immediately without waiting for Bonjour/NSD cache expiry.

The iOS app must declare `NSLocalNetworkUsageDescription` and list `_expo-lan-game._tcp` in `NSBonjourServices`. The example app includes both declarations in `app.json`.

## Generic Lobby Policy

`@opengamesonline/expo-lan-multiplayer` owns network authority and host/client session roles, but it does not assign game-specific roles or capacity rules. Applications provide JSON-safe participant metadata and opaque lobby metadata when creating a typed `LanMultiplayer` instance.

`createGame` accepts application callbacks that:

- validate a candidate against the current participant roster with `validateJoin`;
- validate the finalized roster before starting with `validateStart`;
- create authoritative state at start time with `createInitialState`;
- derive discovery metadata after each roster change with `getLobbyMetadata`; and
- reduce an event with the connection-bound participant identity and metadata.

The host is always the network authority but may have any application-defined participant metadata. For example, a card game can mark the host as a spectator, exclude that participant from its player roster in `createInitialState`, and reject spectator commands in `reduceEvent`. The multiplayer package transports those values without interpreting role names, player limits, turn order, or game rules.

## Current Limitations

- Sessions are foreground-only. Backgrounding the app, switching apps, or locking the device may suspend networking and JavaScript execution. Connections might survive briefly, but background hosting and gameplay are not supported.
- Sessions do not reconnect or resume after a connection is lost. Returning an app to the foreground does not automatically restore its previous session or synchronize missed state.
- Host migration is not supported. If the host leaves, disconnects, or is suspended, the session ends for every client.
- Traffic is not authenticated or encrypted. Participant identity is session-local, and the host is trusted as the authority. Use the packages only on trusted local networks unless the application adds its own security layer.
- Discovery and connections are LAN-only. There is no internet matchmaking, relay service, NAT traversal, or support for routers that block multicast DNS or isolate Wi-Fi clients.
- The native socket module supports one advertised server and one discovery operation at a time. A `LanMultiplayer` instance supports one active game session at a time.
- Native transport capacity is limited to 32 simultaneous connections. Game-browser watcher connections count toward this limit alongside joined participants.
- Participant metadata, lobby metadata, and game event payloads are application-defined. TypeScript types are not runtime validation; hosts must validate untrusted metadata and events in their policy callbacks and reducers.
- The packages require a native development or production build and do not run in Expo Go or on the web.
- Bonjour and NSD timing depends on the platform and network. The example includes a manual **Refresh** action because Android emulators can delay discovering a game created after browsing has already started.
- Emulator networking does not fully represent a physical LAN. The development bridge supports Android-emulator hosts connecting to an iOS Simulator, but it is test tooling rather than production functionality.

## Prerequisites

- Android: macOS or Linux with Android SDK Platform 36, Build Tools 35 or newer, Platform Tools, and Java 17 or newer.
- Android: two emulators or USB-debuggable physical devices.
- iOS: macOS with Xcode 26.4 or newer, Xcode Command Line Tools, and an iOS 16.4 or newer Simulator runtime.
- Both physical test devices must be on the same local network for Bonjour/NSD discovery.

This repository includes a Nix development shell for Node.js and the other project tools:

```zsh
nix develop
```

On macOS, expose the Android SDK if it is not already configured by your shell:

```zsh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

Confirm that Android targets are available:

```zsh
adb devices -l
```

On macOS, confirm that Xcode and at least one iOS Simulator are available:

```zsh
xcodebuild -version
xcrun simctl list devices available
```

Install a Simulator runtime from **Xcode > Settings > Components** if the device list is empty.

## Initial Setup

Install and build the packages in dependency order. The explicit socket build also avoids npm's local-package install-script restrictions.

```zsh
cd expo-lan-sockets
npm install
npm run build

cd ../expo-lan-multiplayer
npm install
npm test

cd ../expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm install
npm run check
```

The example is a 3x3 shared tile board. It includes `expo-dev-client`; it does not run in Expo Go.

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

After the development client has been installed, press **Shift + I** in Metro's terminal UI to select and reopen an iOS Simulator without rebuilding the native app.

### Android Host to iOS Simulator Bridge

The Android emulator uses NAT, so an iOS Simulator cannot connect to the emulator address advertised through Bonjour. For an emulator-only cross-platform test, replace `npm start` with the bridge command:

```zsh
cd expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm run bridge
```

The script starts Metro and an external sidecar that monitors every running `emulator-*` device from `adb devices`. Emulators can be started or stopped while the sidecar runs. When an emulator advertises a game, the sidecar matches its Bonjour address to the AVD's guest interfaces, verifies its dynamic port, creates the matching ADB forward, starts a TCP relay on the Mac, and publishes a labeled Bonjour proxy. The application and native modules continue using their normal dynamic ports and Bonjour connection path.

Leave the script running, create the game on any Android emulator, choose **Find games** on iOS, and join the service named `Game name [bridge emulator-5554]`. Do not select the original service because it still resolves through the emulator's unreachable NAT path. Press **Ctrl-C** to stop Metro and remove all proxy advertisements, relays, and ADB forwarding rules.

Services hosted outside the connected Android emulators are ignored. The sidecar is development tooling only and requires no special native build. Use regular `npm start` when iOS is hosting or when testing physical devices.

## Development Loop

Metro reads these directories directly through `metro.config.js`:

- `expo-lan-sockets/src`
- `expo-lan-multiplayer/src`
- `expo-lan-sockets/@opengamesonline/expo-lan-sockets-example`

Changes in those TypeScript files use Fast Refresh and do not require rebuilding package output.

After changing Kotlin, Swift, a native manifest, native dependencies, or Expo app configuration, reinstall the corresponding native build on each target:

```zsh
npm run android:device -- --no-bundler
npm run ios -- --device --no-bundler
```

Run the local checks separately when changing public package APIs:

```zsh
cd expo-lan-sockets
npm run build
npm run lint

cd ../expo-lan-multiplayer
npm test

cd ../expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm run check
```

The multiplayer tests use an injected in-memory socket transport and cover generic participant metadata, app-defined join and start policy, finalized-roster state initialization, live opaque lobby metadata, host-only game start, authoritative event identity, leaving, disconnects, late joins, and fragmented TCP frames.

With at least one Android emulator or device connected, run the native loopback integration suite from the example app:

```zsh
npm run test:android:sockets
```

The Android suite exercises server restart, client connect and disconnect, bidirectional binary messages, broadcasts to multiple clients, repeated lifecycle cycles, full manager cleanup, and injected socket cleanup failures. It tests the JDK `ServerSocket` and `Socket` transport directly; NSD discovery remains a physical-device end-to-end concern.

## Testing Multiplayer

1. Open the app on both targets.
2. Choose **Create game** on the first target.
3. Choose **Find games** on the second target.
4. Confirm the advertised player count and capacity, join the game, and verify both players appear in the lobby.
5. Choose **Start game** on the host.
6. Press tiles from both devices and confirm that both boards update.
7. Leave the game and confirm the player is removed.

Physical devices on the same Wi-Fi network are recommended for final Bonjour/NSD testing. Android emulators may not forward multicast DNS between emulator instances even when both apps and TCP transport work correctly. Use the development bridge above when an Android emulator must host for an iOS Simulator.

If a development client cannot connect, confirm Metro is listening on port `8081`, the host firewall allows local connections, and the device can reach the host machine's LAN address. Rerunning `npm run android:device -- --no-bundler` reopens the correct development URL.
