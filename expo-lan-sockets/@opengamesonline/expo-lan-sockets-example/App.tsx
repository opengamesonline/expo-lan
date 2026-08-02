import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { DiscoveredService } from '@opengamesonline/expo-lan-sockets';
import {
  GameSession,
  LanMultiplayer,
  type SessionSnapshot,
} from '@opengamesonline/expo-lan-multiplayer';

type TileState = { tiles: Array<number | null> };
type TileEvent = { type: 'claimTile'; tile: number };
type Screen = 'home' | 'games' | 'session';

const PLAYER_COLORS = ['#F05D5E', '#36C5A3', '#F4B942', '#6C8CFF', '#C77DFF', '#FF8C42'];
const multiplayer = new LanMultiplayer();

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [playerName, setPlayerName] = useState('Player');
  const [gameName, setGameName] = useState('Tile Clash');
  const [games, setGames] = useState<DiscoveredService[]>([]);
  const [session, setSession] = useState<GameSession<TileState, TileEvent> | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot<TileState> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsubscribeSession = useRef<(() => void) | null>(null);

  useEffect(() => multiplayer.subscribeToGames(setGames), []);

  function watchSession(nextSession: GameSession<TileState, TileEvent>) {
    unsubscribeSession.current?.();
    unsubscribeSession.current = nextSession.subscribe(setSnapshot);
    setSession(nextSession);
    setScreen('session');
  }

  async function createGame() {
    setBusy(true);
    setError(null);
    try {
      const nextSession = await multiplayer.createGame<TileState, TileEvent>({
        name: gameName,
        playerName,
        maxPlayers: PLAYER_COLORS.length,
        initialState: { tiles: Array<number | null>(9).fill(null) },
        reduceEvent(state, event, player) {
          if (event.type !== 'claimTile' || !Number.isInteger(event.tile) || event.tile < 0 || event.tile > 8) {
            return state;
          }
          const tiles = [...state.tiles];
          tiles[event.tile] = player.slot;
          return { tiles };
        },
      });
      watchSession(nextSession);
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
      await multiplayer.startDiscovery();
      setScreen('games');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function joinGame(service: DiscoveredService) {
    setBusy(true);
    setError(null);
    try {
      const nextSession = await multiplayer.joinGame<TileState, TileEvent>({ service, playerName });
      watchSession(nextSession);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function leaveGame() {
    if (!session) return;
    setBusy(true);
    try {
      await session.leaveGame();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      unsubscribeSession.current?.();
      unsubscribeSession.current = null;
      setSession(null);
      setSnapshot(null);
      setScreen('home');
      setBusy(false);
    }
  }

  async function backFromGames() {
    await multiplayer.stopDiscovery();
    setScreen('home');
  }

  async function claimTile(tile: number) {
    try {
      await session?.sendGameEvent({ type: 'claimTile', tile });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function startGame() {
    setBusy(true);
    setError(null);
    try {
      await session?.startGame();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.glow} />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.brandRow}>
          <View style={styles.brandMark}><Text style={styles.brandMarkText}>9</Text></View>
          <View>
            <Text style={styles.eyebrow}>LOCAL MULTIPLAYER</Text>
            <Text style={styles.brand}>Tile Clash</Text>
          </View>
        </View>

        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
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
          <Games games={games} busy={busy} onJoin={joinGame} onBack={backFromGames} />
        ) : null}
        {screen === 'session' && snapshot?.phase === 'lobby' ? (
          <Lobby snapshot={snapshot} busy={busy} onStart={startGame} onLeave={leaveGame} />
        ) : null}
        {screen === 'session' && snapshot?.phase === 'started' ? (
          <Board snapshot={snapshot} busy={busy} onClaim={claimTile} onLeave={leaveGame} />
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
      <Text style={styles.body}>Create a game on this Wi-Fi network or discover a nearby host. No internet required.</Text>
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
  games: DiscoveredService[];
  busy: boolean;
  onJoin(game: DiscoveredService): void;
  onBack(): void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Nearby games</Text>
      <Text style={styles.body}>Searching the local network...</Text>
      {props.games.length === 0 ? (
        <View style={styles.empty}><ActivityIndicator color="#36C5A3" /><Text style={styles.emptyText}>Waiting for a host</Text></View>
      ) : props.games.map((game) => (
        <Pressable key={game.serviceId} style={styles.gameRow} disabled={props.busy} onPress={() => props.onJoin(game)}>
          <View><Text style={styles.gameName}>{game.name}</Text><Text style={styles.gameType}>LAN GAME</Text></View>
          <Text style={styles.join}>JOIN</Text>
        </Pressable>
      ))}
      <ActionButton label="Back" disabled={props.busy} onPress={props.onBack} />
    </View>
  );
}

function Lobby(props: {
  snapshot: SessionSnapshot<TileState>;
  busy: boolean;
  onStart(): void;
  onLeave(): void;
}) {
  const isHost = props.snapshot.role === 'host';
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>GAME LOBBY</Text>
      <Text style={styles.title}>{isHost ? 'Ready when you are.' : 'Waiting for the host.'}</Text>
      <Text style={styles.body}>
        {isHost
          ? 'Players can join while this lobby is open. Start the game when everyone is here.'
          : 'You are connected. The board will open when the host starts the game.'}
      </Text>
      <PlayerList snapshot={props.snapshot} />
      {isHost ? (
        <ActionButton label="Start game" primary disabled={props.busy} onPress={props.onStart} />
      ) : (
        <View style={styles.waiting}><ActivityIndicator color="#36C5A3" /><Text style={styles.emptyText}>Host controls the start</Text></View>
      )}
      <ActionButton label={isHost ? 'Close lobby' : 'Leave lobby'} disabled={props.busy} onPress={props.onLeave} />
    </View>
  );
}

function Board(props: {
  snapshot: SessionSnapshot<TileState>;
  busy: boolean;
  onClaim(tile: number): void;
  onLeave(): void;
}) {
  const connected = props.snapshot.status === 'connected';
  return (
    <View style={styles.card}>
      <View style={styles.sessionHeader}>
        <View>
          <Text style={styles.title}>{props.snapshot.role === 'host' ? 'Hosting' : 'Joined game'}</Text>
          <Text style={styles.status}>{props.snapshot.status.toUpperCase()} · REV {props.snapshot.revision}</Text>
        </View>
        <View style={[styles.selfColor, { backgroundColor: colorForSlot(props.snapshot.self?.slot ?? 0) }]} />
      </View>
      <PlayerList snapshot={props.snapshot} />
      <View style={styles.board}>
        {(props.snapshot.state?.tiles ?? Array(9).fill(null)).map((slot, index) => (
          <Pressable
            key={index}
            disabled={!connected}
            onPress={() => props.onClaim(index)}
            style={({ pressed }) => [
              styles.tile,
              slot === null ? styles.emptyTile : { backgroundColor: colorForSlot(slot) },
              pressed && styles.pressedTile,
            ]}
          >
            <Text style={styles.tileNumber}>{index + 1}</Text>
          </Pressable>
        ))}
      </View>
      {props.snapshot.error ? <Text style={styles.sessionError}>{props.snapshot.error}</Text> : null}
      <ActionButton label={props.snapshot.role === 'host' ? 'End game' : 'Leave game'} disabled={props.busy} onPress={props.onLeave} />
    </View>
  );
}

function PlayerList(props: { snapshot: SessionSnapshot<TileState> }) {
  return (
    <View style={styles.players}>
      {props.snapshot.players.map((player) => (
        <View key={player.id} style={styles.player}>
          <View style={[styles.playerDot, { backgroundColor: colorForSlot(player.slot) }]} />
          <Text style={styles.playerName}>{player.name}{player.id === props.snapshot.self?.id ? ' (you)' : ''}</Text>
        </View>
      ))}
    </View>
  );
}

function ActionButton(props: { label: string; primary?: boolean; disabled?: boolean; onPress(): void }) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.primary ? styles.primaryButton : styles.secondaryButton,
        pressed && styles.pressedButton,
        props.disabled && styles.disabledButton,
      ]}
    >
      <Text style={[styles.buttonText, props.primary && styles.primaryButtonText]}>{props.label}</Text>
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
  glow: { position: 'absolute', top: -120, right: -100, width: 300, height: 300, borderRadius: 150, backgroundColor: '#26234A' },
  page: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 24, paddingBottom: 40 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 28 },
  brandMark: { width: 48, height: 48, borderRadius: 14, backgroundColor: '#F4B942', alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-6deg' }] },
  brandMarkText: { color: '#17130A', fontSize: 27, fontWeight: '900' },
  eyebrow: { color: '#8D90A5', fontSize: 10, fontWeight: '800', letterSpacing: 1.8 },
  brand: { color: '#F5F3EE', fontSize: 25, fontWeight: '900', letterSpacing: -0.8 },
  card: { backgroundColor: '#1A1B26', borderWidth: 1, borderColor: '#2D2F40', borderRadius: 24, padding: 20 },
  title: { color: '#F5F3EE', fontSize: 28, lineHeight: 32, fontWeight: '900', letterSpacing: -1 },
  body: { color: '#A4A6B5', fontSize: 15, lineHeight: 22, marginTop: 10, marginBottom: 24 },
  label: { color: '#8D90A5', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 8 },
  input: { color: '#F5F3EE', backgroundColor: '#12131B', borderWidth: 1, borderColor: '#343648', borderRadius: 14, paddingHorizontal: 15, paddingVertical: 13, fontSize: 16, marginBottom: 18 },
  button: { minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 11 },
  primaryButton: { backgroundColor: '#F4B942' },
  secondaryButton: { borderWidth: 1, borderColor: '#3C3F53', backgroundColor: '#222431' },
  buttonText: { color: '#F5F3EE', fontSize: 15, fontWeight: '800' },
  primaryButtonText: { color: '#17130A' },
  pressedButton: { transform: [{ scale: 0.98 }], opacity: 0.85 },
  disabledButton: { opacity: 0.45 },
  spinner: { marginTop: 16 },
  error: { backgroundColor: '#49272C', borderColor: '#7A3C45', borderWidth: 1, padding: 12, borderRadius: 12, marginBottom: 14 },
  errorText: { color: '#FFB7BE', fontSize: 13 },
  empty: { height: 150, alignItems: 'center', justifyContent: 'center', gap: 12, borderRadius: 16, backgroundColor: '#13141D', marginBottom: 8 },
  emptyText: { color: '#8D90A5', fontSize: 14 },
  waiting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 50, marginTop: 8 },
  gameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#303241', paddingVertical: 17 },
  gameName: { color: '#F5F3EE', fontSize: 17, fontWeight: '800' },
  gameType: { color: '#6F7184', fontSize: 9, fontWeight: '800', letterSpacing: 1.3, marginTop: 4 },
  join: { color: '#36C5A3', fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },
  sessionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  status: { color: '#8D90A5', fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginTop: 7 },
  selfColor: { width: 34, height: 34, borderRadius: 11, borderWidth: 3, borderColor: '#F5F3EE' },
  players: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 20 },
  player: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#12131B', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 20 },
  playerDot: { width: 9, height: 9, borderRadius: 5 },
  playerName: { color: '#C7C8D2', fontSize: 12, fontWeight: '700' },
  board: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 12 },
  tile: { width: '30%', aspectRatio: 1, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  emptyTile: { backgroundColor: '#252735', borderColor: '#3A3D50', borderWidth: 1 },
  pressedTile: { transform: [{ scale: 0.94 }] },
  tileNumber: { color: 'rgba(255,255,255,0.45)', fontSize: 13, fontWeight: '900' },
  sessionError: { color: '#FFB7BE', textAlign: 'center', marginVertical: 10 },
});
