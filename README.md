# Expo LAN

Android-first LAN multiplayer for Expo applications.

## Packages

- `@opengamesonline/expo-lan-sockets` wraps Android `NsdManager`, `ServerSocket`, and `Socket` for native service discovery and TCP transport.
- `@opengamesonline/expo-lan-multiplayer` adds message framing and host-authoritative TypeScript game sessions.

The MVP supports one advertised server, one discovery operation, multiple clients, create/join/leave flows, and generic game events. It is foreground-only and does not implement authentication, reconnection, host migration, or background hosting.

## Prerequisites

- macOS or Linux with the Android SDK installed.
- Android SDK Platform 36, Build Tools 35 or newer, and Platform Tools.
- Java 17 or newer.
- Two Android emulators or USB-debuggable physical devices.
- Both test devices on the same local network for NSD discovery.

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

In a second terminal, build and install the development client on the first target:

```zsh
cd expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
npm run android:device -- --no-bundler
```

Select the first emulator or physical device when prompted. Run the same command again and select the second target. Gradle is incremental, so the second installation is substantially faster.

`expo run:android` generates the ignored `android/` project when needed, installs the debug APK, and opens the running Metro URL in the development client.

## Development Loop

Metro reads these directories directly through `metro.config.js`:

- `expo-lan-sockets/src`
- `expo-lan-multiplayer/src`
- `expo-lan-sockets/@opengamesonline/expo-lan-sockets-example`

Changes in those TypeScript files use Fast Refresh and do not require rebuilding package output.

After changing Kotlin, `AndroidManifest.xml`, native dependencies, or Expo app configuration, reinstall the native build on each target:

```zsh
npm run android:device -- --no-bundler
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

The multiplayer tests use an injected in-memory socket transport and cover lobby creation and joining, host-only game start, client start notifications, authoritative tile synchronization, leaving, disconnects, late joins, and fragmented TCP frames.

With at least one Android emulator or device connected, run the native loopback integration suite from the example app:

```zsh
npm run test:android:sockets
```

The Android suite exercises server restart, client connect and disconnect, bidirectional binary messages, broadcasts to multiple clients, repeated lifecycle cycles, full manager cleanup, and injected socket cleanup failures. It tests the JDK `ServerSocket` and `Socket` transport directly; NSD discovery remains a physical-device end-to-end concern.

## Testing Multiplayer

1. Open the app on both targets.
2. Choose **Create game** on the first target.
3. Choose **Find games** on the second target.
4. Join the advertised game and confirm both players appear in the lobby.
5. Choose **Start game** on the host.
6. Press tiles from both devices and confirm that both boards update.
7. Leave the game and confirm the player is removed.

Physical devices on the same Wi-Fi network are recommended for NSD testing. Android emulators may not forward multicast DNS between emulator instances even when both apps and TCP transport work correctly.

If a development client cannot connect, confirm Metro is listening on port `8081`, the host firewall allows local connections, and the device can reach the host machine's LAN address. Rerunning `npm run android:device -- --no-bundler` reopens the correct development URL.
