import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  type CreateGameOptions,
  type DiscoveredGame,
  GameSession,
  LanMultiplayer,
  type SessionSnapshot,
} from '@opengamesonline/expo-lan-multiplayer';

type TileState = { tiles: Array<number | null> };
type TileEvent = { type: 'claimTile'; tile: number };
type TileParticipantMetadata = null;
type TileLobbyMetadata = {
  playerCount: number;
  minPlayers: number;
  maxPlayers: number;
};
type TileSession = GameSession<TileState, TileEvent, TileParticipantMetadata, TileLobbyMetadata>;
type TileSnapshot = SessionSnapshot<TileState, TileParticipantMetadata, TileLobbyMetadata>;
type TileHostOptions = CreateGameOptions<
  TileState,
  TileEvent,
  TileParticipantMetadata,
  TileLobbyMetadata
>;
type BoundHostOptions = {
  session: TileSession;
  options: TileHostOptions;
  canonical: boolean;
};
type Screen = 'home' | 'games' | 'session';

const PLAYER_COLORS = ['#F05D5E', '#36C5A3', '#F4B942', '#6C8CFF', '#C77DFF', '#FF8C42'];
const MIN_PLAYERS = 2;
const MAX_PLAYERS = PLAYER_COLORS.length;
const multiplayer = new LanMultiplayer<TileParticipantMetadata, TileLobbyMetadata>();

function createTileHostOptions(name: string, participantName: string): TileHostOptions {
  return {
    name,
    participantName,
    participantMetadata: null,
    createInitialState() {
      return { tiles: Array<number | null>(9).fill(null) };
    },
    getLobbyMetadata(_participants, connectedParticipantIds) {
      return {
        playerCount: connectedParticipantIds.size,
        minPlayers: MIN_PLAYERS,
        maxPlayers: MAX_PLAYERS,
      };
    },
    validateJoin(candidate, participants) {
      if (
        participants.some(
          (participant) => participant.name.toLowerCase() === candidate.name.toLowerCase()
        )
      ) {
        return 'That participant name is already in use';
      }
      return participants.length >= MAX_PLAYERS ? 'The game is full' : null;
    },
    validateStart(_participants, connectedParticipantIds) {
      return connectedParticipantIds.size < MIN_PLAYERS
        ? `At least ${MIN_PLAYERS} connected participants are required to start the game`
        : null;
    },
    reduceEvent(state, event, participant) {
      if (
        event.type !== 'claimTile' ||
        !Number.isInteger(event.tile) ||
        event.tile < 0 ||
        event.tile > 8
      ) {
        return state;
      }
      const tiles = [...state.tiles];
      tiles[event.tile] = participant.slot;
      return { tiles };
    },
  };
}

function hasRecoveryIdentity(snapshot: TileSnapshot): boolean {
  return Boolean(snapshot.self && snapshot.tableId && snapshot.hostParticipantId);
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [playerName, setPlayerName] = useState('Player');
  const [gameName, setGameName] = useState('Tile Clash');
  const [games, setGames] = useState<DiscoveredGame<TileLobbyMetadata>[]>([]);
  const [snapshot, setSnapshot] = useState<TileSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryResult, setRecoveryResult] = useState<'reconnected' | 'promoted' | null>(null);
  const [recovering, setRecovering] = useState(false);
  const unsubscribeSession = useRef<(() => void) | null>(null);
  const joinAttempt = useRef(0);
  const sessionRef = useRef<TileSession | null>(null);
  const snapshotRef = useRef<TileSnapshot | null>(null);
  const hostOptionsRef = useRef<BoundHostOptions | null>(null);
  const screenRef = useRef<Screen>('home');
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const appStateGeneration = useRef(0);
  const operationTail = useRef<Promise<void>>(Promise.resolve());
  const sessionGeneration = useRef(0);
  const recoveryRequest = useRef(0);
  const recoveryInFlight = useRef<number | null>(null);
  const recoveryBlocked = useRef(false);
  const authorityMonitoringSession = useRef<TileSession | null>(null);
  const authorityMonitoringRetryAt = useRef(0);
  const lastSessionError = useRef<string | null>(null);

  useEffect(() => multiplayer.subscribeToGames(setGames), []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
      const appStateChange = ++appStateGeneration.current;
      if (nextState === 'background') {
        const suspendedSession = sessionRef.current;
        const generation = sessionGeneration.current;
        recoveryRequest.current += 1;
        multiplayer.cancelRecovery();
        authorityMonitoringSession.current = null;
        void enqueueOperation(async () => {
          if (
            suspendedSession &&
            sessionRef.current === suspendedSession &&
            sessionGeneration.current === generation &&
            appStateRef.current === 'background' &&
            appStateGeneration.current === appStateChange
          ) {
            await multiplayer.suspendSession();
          }
          if (
            appStateRef.current === 'background' &&
            appStateGeneration.current === appStateChange
          ) {
            await multiplayer.stopDiscovery();
          }
        }).catch(() => undefined);
        return;
      }
      if (nextState !== 'active') return;

      const currentSession = sessionRef.current;
      const currentSnapshot = snapshotRef.current;
      if (
        currentSession &&
        currentSnapshot &&
        (currentSnapshot.status === 'disconnected' || currentSnapshot.status === 'reconnecting')
      ) {
        void requestRecovery(currentSession);
      } else if (
        currentSession &&
        currentSnapshot?.role === 'host' &&
        currentSnapshot.status === 'connected'
      ) {
        ensureAuthorityMonitoring(currentSession);
      } else if (!currentSession && screenRef.current === 'games') {
        void enqueueOperation(() => multiplayer.startDiscovery()).catch((cause) => {
          setError(errorMessage(cause));
        });
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const currentSession = sessionRef.current;
      const currentSnapshot = snapshotRef.current;
      if (
        appStateRef.current === 'active' &&
        currentSession &&
        currentSnapshot?.role === 'host' &&
        currentSnapshot.status === 'connected'
      ) {
        ensureAuthorityMonitoring(currentSession);
        if (multiplayer.hasHigherAuthority(currentSession)) {
          authorityMonitoringSession.current = null;
          void requestRecovery(currentSession);
        }
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      sessionGeneration.current += 1;
      recoveryRequest.current += 1;
      multiplayer.cancelRecovery();
      unsubscribeSession.current?.();
    },
    []
  );

  function enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.current.then(operation, operation);
    operationTail.current = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function showScreen(nextScreen: Screen) {
    screenRef.current = nextScreen;
    setScreen(nextScreen);
  }

  function watchSession(
    nextSession: TileSession,
    options: TileHostOptions,
    canonicalOptions: boolean
  ) {
    const generation = ++sessionGeneration.current;
    unsubscribeSession.current?.();
    sessionRef.current = nextSession;
    hostOptionsRef.current = {
      session: nextSession,
      options,
      canonical: canonicalOptions,
    };
    snapshotRef.current = nextSession.snapshot;
    recoveryBlocked.current = false;
    authorityMonitoringSession.current = null;
    authorityMonitoringRetryAt.current = 0;
    lastSessionError.current = null;
    setRecoveryError(null);
    setRecoveryResult(null);
    unsubscribeSession.current = nextSession.subscribe((nextSnapshot) => {
      if (sessionRef.current !== nextSession || sessionGeneration.current !== generation) return;
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);

      const boundOptions = hostOptionsRef.current;
      if (
        nextSnapshot.status === 'connected' &&
        nextSnapshot.self &&
        nextSnapshot.tableId &&
        boundOptions?.session === nextSession &&
        !boundOptions.canonical
      ) {
        const recovery = nextSession.exportRecoveryState();
        hostOptionsRef.current = {
          session: nextSession,
          options: createTileHostOptions(recovery.name, nextSnapshot.self.name),
          canonical: true,
        };
      }

      if (nextSnapshot.status === 'connected') {
        recoveryBlocked.current = false;
        setRecoveryError(null);
        if (nextSnapshot.role === 'host') {
          if (nextSnapshot.error && nextSnapshot.error !== lastSessionError.current) {
            authorityMonitoringSession.current = null;
            authorityMonitoringRetryAt.current = Date.now() + 2_000;
          }
          lastSessionError.current = nextSnapshot.error;
          ensureAuthorityMonitoring(nextSession);
        } else {
          lastSessionError.current = nextSnapshot.error;
        }
      } else {
        authorityMonitoringSession.current = null;
        lastSessionError.current = nextSnapshot.error;
      }

      if (nextSnapshot.status === 'disconnected' && !hasRecoveryIdentity(nextSnapshot)) {
        recoveryBlocked.current = true;
        setRecoveryError(nextSnapshot.error ?? 'The join was not accepted');
      } else if (
        nextSnapshot.status === 'disconnected' &&
        appStateRef.current === 'active' &&
        !recoveryBlocked.current
      ) {
        void requestRecovery(nextSession);
      }
    });
    showScreen('session');

    if (appStateRef.current === 'background') {
      void enqueueOperation(() => multiplayer.suspendSession()).catch(() => undefined);
    }
  }

  function ensureAuthorityMonitoring(targetSession: TileSession) {
    if (
      authorityMonitoringSession.current === targetSession ||
      appStateRef.current !== 'active' ||
      Date.now() < authorityMonitoringRetryAt.current
    ) {
      return;
    }
    authorityMonitoringSession.current = targetSession;
    void enqueueOperation(async () => {
      const currentSnapshot = snapshotRef.current;
      if (
        sessionRef.current !== targetSession ||
        currentSnapshot?.role !== 'host' ||
        currentSnapshot.status !== 'connected' ||
        appStateRef.current !== 'active'
      ) {
        if (authorityMonitoringSession.current === targetSession) {
          authorityMonitoringSession.current = null;
        }
        return;
      }
      await multiplayer.startAuthorityMonitoring();
      authorityMonitoringRetryAt.current = 0;
    }).catch((cause) => {
      if (authorityMonitoringSession.current === targetSession) {
        authorityMonitoringSession.current = null;
      }
      authorityMonitoringRetryAt.current = Date.now() + 2_000;
      if (sessionRef.current === targetSession) setError(errorMessage(cause));
    });
  }

  function requestRecovery(targetSession: TileSession, force = false) {
    const boundOptions = hostOptionsRef.current;
    const currentSnapshot = snapshotRef.current;
    if (
      sessionRef.current !== targetSession ||
      boundOptions?.session !== targetSession ||
      appStateRef.current !== 'active' ||
      !currentSnapshot ||
      !hasRecoveryIdentity(currentSnapshot) ||
      currentSnapshot?.status === 'left' ||
      recoveryInFlight.current !== null ||
      (recoveryBlocked.current && !force)
    ) {
      return;
    }

    if (force) {
      recoveryBlocked.current = false;
      setRecoveryError(null);
    }
    const generation = sessionGeneration.current;
    const request = ++recoveryRequest.current;
    recoveryInFlight.current = request;
    setRecoveryResult(null);
    setRecovering(true);
    void enqueueOperation(async () => {
      try {
        if (
          sessionRef.current !== targetSession ||
          sessionGeneration.current !== generation ||
          recoveryRequest.current !== request ||
          appStateRef.current !== 'active'
        ) {
          return;
        }
        await multiplayer.suspendSession();
        if (
          sessionRef.current !== targetSession ||
          recoveryRequest.current !== request ||
          appStateRef.current !== 'active'
        ) {
          return;
        }
        const result = await multiplayer.recoverGame(targetSession, boundOptions.options);
        const recoveredSnapshot = snapshotRef.current;
        if (
          sessionRef.current === targetSession &&
          sessionGeneration.current === generation &&
          recoveryRequest.current === request &&
          recoveredSnapshot?.status === 'connected'
        ) {
          recoveryBlocked.current = false;
          setRecoveryError(null);
          setRecoveryResult(result);
        }
      } catch (cause) {
        const failedSnapshot = snapshotRef.current;
        if (
          sessionRef.current !== targetSession ||
          sessionGeneration.current !== generation ||
          recoveryRequest.current !== request ||
          appStateRef.current !== 'active'
        ) {
          return;
        }
        if (failedSnapshot?.status === 'left') {
          recoveryBlocked.current = true;
          setRecoveryError(failedSnapshot.error ?? errorMessage(cause));
          return;
        }
        await multiplayer.suspendSession().catch(() => undefined);
        recoveryBlocked.current = true;
        setRecoveryError(errorMessage(cause));
      }
    }).finally(() => {
      if (recoveryInFlight.current !== request) return;
      recoveryInFlight.current = null;
      setRecovering(false);
      const latestSnapshot = snapshotRef.current;
      if (
        sessionRef.current === targetSession &&
        appStateRef.current === 'active' &&
        (latestSnapshot?.status === 'disconnected' || latestSnapshot?.status === 'reconnecting') &&
        !recoveryBlocked.current
      ) {
        void requestRecovery(targetSession);
      }
    });
  }

  async function createGame() {
    setBusy(true);
    setError(null);
    try {
      const options = createTileHostOptions(gameName, playerName);
      const nextSession = await enqueueOperation(() =>
        multiplayer.createGame<TileState, TileEvent>(options)
      );
      watchSession(nextSession, options, true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function findGames() {
    setBusy(true);
    setError(null);
    try {
      await enqueueOperation(() => multiplayer.startDiscovery());
      showScreen('games');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function joinGame(service: DiscoveredGame<TileLobbyMetadata>) {
    const attempt = ++joinAttempt.current;
    setBusy(true);
    setError(null);
    try {
      const options = createTileHostOptions(service.name, playerName);
      const nextSession = await enqueueOperation(() =>
        multiplayer.joinGame<TileState, TileEvent>({
          service,
          participantName: playerName,
          participantMetadata: null,
        })
      );
      if (attempt !== joinAttempt.current) {
        await enqueueOperation(() => nextSession.leaveGame());
        return;
      }
      watchSession(nextSession, options, false);
    } catch (cause) {
      if (attempt === joinAttempt.current) setError(errorMessage(cause));
    } finally {
      if (attempt === joinAttempt.current) setBusy(false);
    }
  }

  async function refreshGames() {
    setBusy(true);
    setError(null);
    try {
      await enqueueOperation(() => multiplayer.refreshDiscovery());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function leaveGame() {
    const currentSession = sessionRef.current;
    if (!currentSession) return;
    sessionGeneration.current += 1;
    recoveryRequest.current += 1;
    multiplayer.cancelRecovery();
    authorityMonitoringSession.current = null;
    sessionRef.current = null;
    snapshotRef.current = null;
    hostOptionsRef.current = null;
    recoveryBlocked.current = false;
    setBusy(true);
    try {
      await enqueueOperation(async () => {
        await currentSession.leaveGame();
        await multiplayer.stopDiscovery();
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      unsubscribeSession.current?.();
      unsubscribeSession.current = null;
      setSnapshot(null);
      setRecoveryError(null);
      setRecoveryResult(null);
      setRecovering(false);
      showScreen('home');
      setBusy(false);
    }
  }

  async function backFromGames() {
    joinAttempt.current += 1;
    multiplayer.cancelPendingJoin();
    setBusy(false);
    showScreen('home');
    try {
      await enqueueOperation(() => multiplayer.stopDiscovery());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function claimTile(tile: number) {
    const currentSession = sessionRef.current;
    if (
      !currentSession ||
      snapshotRef.current?.status !== 'connected' ||
      recoveryInFlight.current !== null
    ) {
      return;
    }
    try {
      await currentSession.sendGameEvent({ type: 'claimTile', tile });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function startGame() {
    setBusy(true);
    setError(null);
    try {
      await sessionRef.current?.startGame();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function retryRecovery() {
    const currentSession = sessionRef.current;
    if (currentSession) requestRecovery(currentSession, true);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.glow} />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.brandRow}>
          <View style={styles.brandMark}>
            <Text style={styles.brandMarkText}>9</Text>
          </View>
          <View>
            <Text style={styles.eyebrow}>LOCAL MULTIPLAYER</Text>
            <Text style={styles.brand}>Tile Clash</Text>
          </View>
        </View>

        {error ? (
          <View style={styles.error}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        {screen === 'home' ? (
          <Home
            playerName={playerName}
            gameName={gameName}
            busy={busy}
            onPlayerName={setPlayerName}
            onGameName={setGameName}
            onCreate={createGame}
            onFind={findGames}
          />
        ) : null}
        {screen === 'games' ? (
          <Games
            games={games}
            busy={busy}
            onJoin={joinGame}
            onRefresh={refreshGames}
            onBack={backFromGames}
          />
        ) : null}
        {screen === 'session' && snapshot?.phase === 'lobby' ? (
          <Lobby
            snapshot={snapshot}
            busy={busy}
            recovering={recovering}
            recoveryError={recoveryError}
            recoveryResult={recoveryResult}
            onStart={startGame}
            onRetry={retryRecovery}
            onLeave={leaveGame}
          />
        ) : null}
        {screen === 'session' && snapshot?.phase === 'started' ? (
          <Board
            snapshot={snapshot}
            busy={busy}
            recovering={recovering}
            recoveryError={recoveryError}
            recoveryResult={recoveryResult}
            onClaim={claimTile}
            onRetry={retryRecovery}
            onLeave={leaveGame}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Home(props: {
  playerName: string;
  gameName: string;
  busy: boolean;
  onPlayerName(value: string): void;
  onGameName(value: string): void;
  onCreate(): void;
  onFind(): void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Paint the board.</Text>
      <Text style={styles.body}>
        Create a game on this Wi-Fi network or discover a nearby host. No internet required.
      </Text>
      <Text style={styles.label}>YOUR NAME</Text>
      <TextInput
        style={styles.input}
        value={props.playerName}
        onChangeText={props.onPlayerName}
        maxLength={24}
        placeholder="Player name"
        placeholderTextColor="#6F7184"
      />
      <Text style={styles.label}>GAME NAME</Text>
      <TextInput
        style={styles.input}
        value={props.gameName}
        onChangeText={props.onGameName}
        maxLength={40}
        placeholder="Game name"
        placeholderTextColor="#6F7184"
      />
      <ActionButton label="Create game" primary disabled={props.busy} onPress={props.onCreate} />
      <ActionButton label="Find games" disabled={props.busy} onPress={props.onFind} />
      {props.busy ? <ActivityIndicator style={styles.spinner} color="#F4B942" /> : null}
    </View>
  );
}

function Games(props: {
  games: DiscoveredGame<TileLobbyMetadata>[];
  busy: boolean;
  onJoin(game: DiscoveredGame<TileLobbyMetadata>): void;
  onRefresh(): void;
  onBack(): void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Nearby games</Text>
      <Text style={styles.body}>Searching the local network...</Text>
      {props.games.length === 0 ? (
        <View style={styles.empty}>
          <ActivityIndicator color="#36C5A3" />
          <Text style={styles.emptyText}>Waiting for a host</Text>
        </View>
      ) : (
        props.games.map((game) => {
          const full = game.lobbyMetadata.playerCount >= game.lobbyMetadata.maxPlayers;
          return (
            <Pressable
              key={game.serviceId}
              style={styles.gameRow}
              disabled={props.busy || full}
              onPress={() => props.onJoin(game)}>
              <View style={styles.gameInfo}>
                <Text style={styles.gameName}>{game.name}</Text>
                <Text style={styles.gameType}>
                  {game.lobbyMetadata.playerCount}/{game.lobbyMetadata.maxPlayers} PLAYERS · MIN{' '}
                  {game.lobbyMetadata.minPlayers}
                </Text>
              </View>
              <Text style={[styles.join, full && styles.full]}>{full ? 'FULL' : 'JOIN'}</Text>
            </Pressable>
          );
        })
      )}
      <ActionButton label="Refresh" disabled={props.busy} onPress={props.onRefresh} />
      <ActionButton label="Back" disabled={props.busy} onPress={props.onBack} />
    </View>
  );
}

function Lobby(props: {
  snapshot: TileSnapshot;
  busy: boolean;
  recovering: boolean;
  recoveryError: string | null;
  recoveryResult: 'reconnected' | 'promoted' | null;
  onStart(): void;
  onRetry(): void;
  onLeave(): void;
}) {
  const isHost = props.snapshot.role === 'host';
  const isClosed = props.snapshot.status === 'left';
  const canRecover = !isClosed && hasRecoveryIdentity(props.snapshot);
  const isDisconnected =
    props.recovering ||
    props.snapshot.status === 'reconnecting' ||
    props.snapshot.status === 'disconnected';
  const isRecovering = isDisconnected && !props.recoveryError;
  const connected = props.snapshot.status === 'connected';
  const lobby = props.snapshot.lobbyMetadata;
  const hasMinimumPlayers = !lobby || lobby.playerCount >= lobby.minPlayers;
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>GAME LOBBY</Text>
      <Text style={styles.title}>
        {isClosed
          ? 'Table closed.'
          : props.recoveryError
            ? 'Recovery paused.'
            : isRecovering
              ? 'Recovering table...'
              : isHost
                ? 'Ready when you are.'
                : 'Waiting for the host.'}
      </Text>
      <Text style={styles.body}>
        {isClosed
          ? 'The host explicitly closed this table. Return home to create or find another game.'
          : props.recoveryError
            ? 'The table could not be recovered automatically. Retry or leave this table.'
            : isRecovering
              ? 'Looking for the current authority. If it is gone, the next available participant will take over.'
              : isHost
                ? 'Players can join while this lobby is open. Start the game when everyone is here.'
                : 'You are connected. The board will open when the host starts the game.'}
      </Text>
      {lobby ? (
        <Text style={styles.capacity}>
          {lobby.playerCount}/{lobby.maxPlayers} players ·{' '}
          {hasMinimumPlayers ? 'Ready to start' : `Need ${lobby.minPlayers} to start`}
        </Text>
      ) : null}
      <PlayerList snapshot={props.snapshot} />
      {props.recoveryResult === 'promoted' && connected ? (
        <Text style={styles.recoverySuccess}>This device is now the host.</Text>
      ) : props.recoveryResult === 'reconnected' && connected ? (
        <Text style={styles.recoverySuccess}>Reconnected to the table.</Text>
      ) : null}
      {props.recoveryError ? (
        <View style={styles.recoveryPanel}>
          <Text style={styles.sessionError}>{props.recoveryError}</Text>
          {canRecover ? (
            <ActionButton label="Retry recovery" primary onPress={props.onRetry} />
          ) : null}
        </View>
      ) : null}
      {isClosed || isDisconnected ? null : isHost ? (
        <ActionButton
          label="Start game"
          primary
          disabled={props.busy || !connected || !hasMinimumPlayers}
          onPress={props.onStart}
        />
      ) : (
        <View style={styles.waiting}>
          <ActivityIndicator color="#36C5A3" />
          <Text style={styles.emptyText}>Host controls the start</Text>
        </View>
      )}
      <ActionButton
        label={isClosed ? 'Back to home' : isHost && connected ? 'Close lobby' : 'Leave table'}
        disabled={props.busy}
        onPress={props.onLeave}
      />
    </View>
  );
}

function Board(props: {
  snapshot: TileSnapshot;
  busy: boolean;
  recovering: boolean;
  recoveryError: string | null;
  recoveryResult: 'reconnected' | 'promoted' | null;
  onClaim(tile: number): void;
  onRetry(): void;
  onLeave(): void;
}) {
  const connected = props.snapshot.status === 'connected';
  const isClosed = props.snapshot.status === 'left';
  const canRecover = !isClosed && hasRecoveryIdentity(props.snapshot);
  const isRecovering =
    !props.recoveryError &&
    (props.recovering ||
      props.snapshot.status === 'reconnecting' ||
      props.snapshot.status === 'disconnected');
  return (
    <View style={styles.card}>
      <View style={styles.sessionHeader}>
        <View>
          <Text style={styles.title}>
            {props.snapshot.role === 'host' ? 'Hosting' : 'Joined game'}
          </Text>
          <Text style={styles.status}>
            {props.snapshot.status.toUpperCase()} · TERM {props.snapshot.authorityTerm} · REV{' '}
            {props.snapshot.revision}
          </Text>
        </View>
        <View
          style={[
            styles.selfColor,
            { backgroundColor: colorForSlot(props.snapshot.self?.slot ?? 0) },
          ]}
        />
      </View>
      <PlayerList snapshot={props.snapshot} />
      <View style={styles.board}>
        {(props.snapshot.state?.tiles ?? Array(9).fill(null)).map((slot, index) => (
          <Pressable
            key={index}
            disabled={!connected || props.busy || props.recovering}
            onPress={() => props.onClaim(index)}
            style={({ pressed }) => [
              styles.tile,
              slot === null ? styles.emptyTile : { backgroundColor: colorForSlot(slot) },
              pressed && styles.pressedTile,
            ]}>
            <Text style={styles.tileNumber}>{index + 1}</Text>
          </Pressable>
        ))}
      </View>
      {isRecovering ? (
        <View style={styles.recoveryPanel}>
          <View style={styles.waiting}>
            <ActivityIndicator color="#36C5A3" />
            <Text style={styles.emptyText}>Recovering the table and authoritative state</Text>
          </View>
        </View>
      ) : null}
      {props.recoveryResult === 'promoted' && connected ? (
        <Text style={styles.recoverySuccess}>Host migrated to this device.</Text>
      ) : props.recoveryResult === 'reconnected' && connected ? (
        <Text style={styles.recoverySuccess}>Connection restored.</Text>
      ) : null}
      {isClosed ? (
        <Text style={styles.sessionError}>
          {props.snapshot.error ?? 'The host closed the table'}
        </Text>
      ) : props.recoveryError ? (
        <View style={styles.recoveryPanel}>
          <Text style={styles.sessionError}>{props.recoveryError}</Text>
          {canRecover ? (
            <ActionButton label="Retry recovery" primary onPress={props.onRetry} />
          ) : null}
        </View>
      ) : props.snapshot.error && !isRecovering ? (
        <Text style={styles.sessionError}>{props.snapshot.error}</Text>
      ) : null}
      <ActionButton
        label={
          isClosed
            ? 'Back to home'
            : props.snapshot.role === 'host' && connected
              ? 'End game'
              : 'Leave table'
        }
        disabled={props.busy}
        onPress={props.onLeave}
      />
    </View>
  );
}

function PlayerList(props: { snapshot: TileSnapshot }) {
  const connectedParticipantIds = new Set(props.snapshot.connectedParticipantIds);
  return (
    <View style={styles.players}>
      {props.snapshot.participants.map((participant) => {
        const connected = connectedParticipantIds.has(participant.id);
        return (
          <View key={participant.id} style={[styles.player, !connected && styles.offlinePlayer]}>
            <View
              style={[
                styles.playerDot,
                { backgroundColor: colorForSlot(participant.slot) },
                !connected && styles.offlinePlayerDot,
              ]}
            />
            <Text style={styles.playerName}>
              {participant.name}
              {participant.id === props.snapshot.self?.id ? ' (you)' : ''}
              {!connected ? ' · offline' : ''}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function ActionButton(props: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.primary ? styles.primaryButton : styles.secondaryButton,
        pressed && styles.pressedButton,
        props.disabled && styles.disabledButton,
      ]}>
      <Text style={[styles.buttonText, props.primary && styles.primaryButtonText]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function colorForSlot(slot: number): string {
  return PLAYER_COLORS[slot % PLAYER_COLORS.length] ?? PLAYER_COLORS[0];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Something went wrong';
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#11121A' },
  glow: {
    position: 'absolute',
    top: -120,
    right: -100,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: '#26234A',
  },
  page: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 24, paddingBottom: 40 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 28 },
  brandMark: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#F4B942',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-6deg' }],
  },
  brandMarkText: { color: '#17130A', fontSize: 27, fontWeight: '900' },
  eyebrow: { color: '#8D90A5', fontSize: 10, fontWeight: '800', letterSpacing: 1.8 },
  brand: { color: '#F5F3EE', fontSize: 25, fontWeight: '900', letterSpacing: -0.8 },
  card: {
    backgroundColor: '#1A1B26',
    borderWidth: 1,
    borderColor: '#2D2F40',
    borderRadius: 24,
    padding: 20,
  },
  title: { color: '#F5F3EE', fontSize: 28, lineHeight: 32, fontWeight: '900', letterSpacing: -1 },
  body: { color: '#A4A6B5', fontSize: 15, lineHeight: 22, marginTop: 10, marginBottom: 24 },
  label: { color: '#8D90A5', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 8 },
  input: {
    color: '#F5F3EE',
    backgroundColor: '#12131B',
    borderWidth: 1,
    borderColor: '#343648',
    borderRadius: 14,
    paddingHorizontal: 15,
    paddingVertical: 13,
    fontSize: 16,
    marginBottom: 18,
  },
  button: {
    minHeight: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 11,
  },
  primaryButton: { backgroundColor: '#F4B942' },
  secondaryButton: { borderWidth: 1, borderColor: '#3C3F53', backgroundColor: '#222431' },
  buttonText: { color: '#F5F3EE', fontSize: 15, fontWeight: '800' },
  primaryButtonText: { color: '#17130A' },
  pressedButton: { transform: [{ scale: 0.98 }], opacity: 0.85 },
  disabledButton: { opacity: 0.45 },
  spinner: { marginTop: 16 },
  error: {
    backgroundColor: '#49272C',
    borderColor: '#7A3C45',
    borderWidth: 1,
    padding: 12,
    borderRadius: 12,
    marginBottom: 14,
  },
  errorText: { color: '#FFB7BE', fontSize: 13 },
  empty: {
    height: 150,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    borderRadius: 16,
    backgroundColor: '#13141D',
    marginBottom: 8,
  },
  emptyText: { color: '#8D90A5', fontSize: 14 },
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 50,
    marginTop: 8,
  },
  gameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#303241',
    paddingVertical: 17,
  },
  gameInfo: { flex: 1, minWidth: 0, marginRight: 12 },
  gameName: { color: '#F5F3EE', fontSize: 17, fontWeight: '800' },
  gameType: { color: '#6F7184', fontSize: 9, fontWeight: '800', letterSpacing: 1.3, marginTop: 4 },
  join: { flexShrink: 0, color: '#36C5A3', fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },
  full: { color: '#8D90A5' },
  capacity: { color: '#F4B942', fontSize: 12, fontWeight: '800', marginTop: -12 },
  sessionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  status: { color: '#8D90A5', fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginTop: 7 },
  selfColor: { width: 34, height: 34, borderRadius: 11, borderWidth: 3, borderColor: '#F5F3EE' },
  players: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 20 },
  player: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#12131B',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 20,
  },
  offlinePlayer: { opacity: 0.5 },
  playerDot: { width: 9, height: 9, borderRadius: 5 },
  offlinePlayerDot: { backgroundColor: '#6F7184' },
  playerName: { color: '#C7C8D2', fontSize: 12, fontWeight: '700' },
  board: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
    marginBottom: 12,
  },
  tile: {
    width: '30%',
    aspectRatio: 1,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTile: { backgroundColor: '#252735', borderColor: '#3A3D50', borderWidth: 1 },
  pressedTile: { transform: [{ scale: 0.94 }] },
  tileNumber: { color: 'rgba(255,255,255,0.45)', fontSize: 13, fontWeight: '900' },
  sessionError: { color: '#FFB7BE', textAlign: 'center', marginVertical: 10 },
  recoveryPanel: { marginBottom: 8 },
  recoverySuccess: { color: '#36C5A3', textAlign: 'center', fontWeight: '800', marginBottom: 4 },
});
