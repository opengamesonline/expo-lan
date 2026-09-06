Expo LAN Networking — Implementation Brief

Goal

Build reusable Expo packages for offline, LAN-based multiplayer where an Android or iOS device can host a game and nearby devices can discover and connect to it without a centralized server or internet connection.

Repository:
expo-lan/

Published packages:
@opengamesonline/expo-lan-sockets
@opengamesonline/expo-lan-multiplayer

Package responsibilities
expo-lan-sockets
Expo native module responsible only for LAN transport and discovery.

Responsibilities:
Start and stop a TCP server.
Connect to a TCP server by hostname/IP and port.
Support multiple simultaneous connections.
Send and receive binary data.
Broadcast data to connected clients.
Emit connection, disconnection, message, and error events.
Advertise services through Bonjour on iOS and NSD on Android.
Discover nearby advertised services.
Resolve discovered services to hostname/IP and port.
Report supported capabilities by platform.

Do not include:
Game rules
Players or turns
Matchmaking
State synchronization
Game-specific messages
Host migration
Application-specific reconnection policy

expo-lan-multiplayer
Higher-level TypeScript package built on expo-lan-sockets.

Responsibilities:
Message framing
Serialization
Session creation and joining (lobby)
Host/client roles
Peer IDs
Authentication using a session token
Request IDs and deduplication
Ordered sequence numbers
Reconnection and session resumption
Authoritative-host message flow
State snapshots and event synchronization
Do not include actual game rules.

expo-lan-sockets/@opengamesonline/expo-lan-sockets-example
Use this for a POC app to test out the functionality
A simple game