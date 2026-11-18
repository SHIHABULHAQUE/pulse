import { decodeServer, encode, type ClientMessage, type ImageAttachment, type RoomSettings, type ServerMessage, type Status } from '@pulse/protocol';
import { toast, upsertRoom, usePulse } from '../store';
import {
  DEFAULT_SETTINGS, HISTORY_LIMIT, getKv, outboxItems, putMessage, queueOutbox, removeOutbox, roomMessages, setKv,
  type JoinedRoom, type LocalMessage, type Settings
} from './db';
import { loadIdentity, signChallenge } from './identity';
import { decryptBody, deriveRoomSecret, encryptBody, newSalt, type RoomSecret } from './roomCrypto';
import { onReconnected, onSignal, onVoiceJoined, onVoiceLeft, onVoiceState } from './voice';

const RESUME_KEY = 'pulse.resume';
const store = () => usePulse.getState();

let ws: WebSocket | null = null;
let authed = false;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let booted = false;
/** Chat sends awaiting their server echo on the current socket. */
const inFlight = new Set<string>();
/** Password-derived secrets for joins/creates in flight, keyed by requestId. Saved with the room once the server confirms. */
const pendingSecrets = new Map<string, RoomSecret>();

const secretFor = (roomId: string): RoomSecret | undefined => store().joined.find((r) => r.id === roomId)?.secret;

function wsUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/* ------------------------------------------------------------------ boot */

export async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  try {
    const { identity, profile } = await loadIdentity();
    const settings = { ...DEFAULT_SETTINGS, ...((await getKv('settings')) ?? {}) } as Settings;
    const joined = (await getKv('rooms')) ?? [];
    const activeRoom = joined[0]?.id ?? 'lobby';
    store().set({ identity, profile, settings, joined, activeRoom });
    for (const room of joined) await loadRoomHistory(room.id);
  } catch (err) {
    store().set({ conn: 'offline' });
    toast(window.isSecureContext ? `Could not load your identity: ${(err as Error).message}` : 'Pulse needs HTTPS (or localhost) to create your identity.', 'error');
    return;
  }
  connect();
  window.addEventListener('online', () => { if (!ws) { attempt = 0; connect(); } });
  // Browsers keep a dead socket "open" for a long time after the network drops; close it ourselves.
  window.addEventListener('offline', () => ws?.close());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !ws) { attempt = 0; connect(); } });
}

async function loadRoomHistory(roomId: string): Promise<void> {
  const history = await roomMessages(roomId);
  store().set((s) => ({ messages: { ...s.messages, [roomId]: history } }));
}

/* ------------------------------------------------------------------ socket */

function connect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  store().set({ conn: 'connecting' });
  const socket = new WebSocket(wsUrl());
  ws = socket;
  socket.onmessage = (event) => {
    let message: ServerMessage;
    try { message = decodeServer(String(event.data)); } catch { return; }
    void onMessage(socket, message);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    authed = false;
    inFlight.clear();
    store().set({ conn: 'offline', presence: [] });
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  if (!navigator.onLine) return; // the 'online' listener reconnects
  const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
  attempt += 1;
  reconnectTimer = setTimeout(connect, delay);
}

export function send(message: ClientMessage): boolean {
  if (!ws || !authed || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(encode(message));
  return true;
}

/* ------------------------------------------------------------------ inbound */

async function onMessage(socket: WebSocket, message: ServerMessage): Promise<void> {
  const s = store();
  switch (message.type) {
    case 'server.challenge': {
      const { identity, profile } = s;
      if (!identity || !profile) return;
      const signature = await signChallenge(identity, message.payload.challenge);
      const resumeToken = sessionStorage.getItem(RESUME_KEY) ?? undefined;
      socket.send(encode({ type: 'client.hello', requestId: 'hello', payload: { publicKey: identity.publicKeySpki, signature, handle: profile.handle, ...(resumeToken ? { resumeToken } : {}) } }));
      return;
    }
    case 'server.ready': {
      authed = true;
      attempt = 0;
      sessionStorage.setItem(RESUME_KEY, message.payload.resumeToken);
      s.set({ conn: 'online', directory: message.payload.rooms });
      const already = new Set(message.payload.joinedRooms);
      const wanted = s.joined.length > 0 ? s.joined : [{ id: 'lobby', secret: undefined }];
      for (const room of wanted) {
        if (!already.has(room.id)) send({ type: 'room.join', requestId: `rejoin:${room.id}`, payload: { roomId: room.id, ...(room.secret ? { proof: room.secret.proof } : {}) } });
      }
      if (s.profile && s.profile.status !== 'online') send({ type: 'presence.update', requestId: 'status', payload: { status: s.profile.status } });
      onReconnected();
      void flushOutbox();
      return;
    }
    case 'voice.joined':
      onVoiceJoined(message.payload);
      return;
    case 'voice.left':
      onVoiceLeft(message.payload);
      return;
    case 'voice.state':
      onVoiceState(message.payload);
      return;
    case 'rtc.signal':
      onSignal(message.payload);
      return;
    case 'room.listed':
      s.set({ directory: message.payload.rooms });
      return;
    case 'room.updated':
      s.set((st) => ({ directory: upsertRoom(st.directory, message.payload) }));
      return;
    case 'room.removed': {
      const { roomId } = message.payload;
      const wasJoined = s.joined.some((r) => r.id === roomId);
      s.set((st) => ({ directory: st.directory.filter((r) => r.id !== roomId) }));
      if (wasJoined) { await forgetRoom(roomId); toast('A room you were in has expired'); }
      return;
    }
    case 'room.joined': {
      const room = message.payload;
      s.set((st) => ({ directory: upsertRoom(st.directory, room) }));
      const secret = pendingSecrets.get(message.requestId);
      pendingSecrets.delete(message.requestId);
      if (!s.joined.some((r) => r.id === room.id)) {
        const entry: JoinedRoom = { id: room.id, name: room.name, owned: room.ownerKey === s.identity?.publicKeySpki, joinedAt: Date.now(), ...(secret ? { secret } : {}) };
        const joined = [...s.joined, entry];
        s.set({ joined });
        await setKv('rooms', joined);
        await loadRoomHistory(room.id);
      }
      if (message.requestId.startsWith('user:')) s.set({ activeRoom: room.id, dialog: null });
      else if (!store().activeRoom) s.set({ activeRoom: room.id });
      void flushOutbox();
      return;
    }
    case 'room.left':
      await forgetRoom(message.payload.roomId);
      return;
    case 'presence.snapshot':
      s.set({ presence: message.payload });
      return;
    case 'chat.message':
      await receiveChat(message.payload);
      return;
    case 'server.error':
      await onError(message.requestId, message.payload);
      return;
  }
}

async function forgetRoom(roomId: string): Promise<void> {
  const joined = store().joined.filter((r) => r.id !== roomId);
  store().set((st) => ({ joined, activeRoom: st.activeRoom === roomId ? (joined[0]?.id ?? null) : st.activeRoom }));
  await setKv('rooms', joined);
}

async function onError(requestId: string, { code, message, retryAfterMs }: Extract<ServerMessage, { type: 'server.error' }>['payload']): Promise<void> {
  if (requestId.startsWith('chat:')) {
    const cmid = requestId.slice(5);
    inFlight.delete(cmid);
    if (code === 'RATE_LIMITED' || code === 'SLOW_MODE') {
      if (code === 'SLOW_MODE') toast(message);
      setTimeout(() => void flushOutbox(), (retryAfterMs ?? 2000) + 50);
      return;
    }
    await removeOutbox(cmid);
    updateMessage(cmid, (m) => ({ ...m, state: 'failed', error: message }));
    return;
  }
  if (requestId.startsWith('rejoin:') && (code === 'ROOM_NOT_FOUND' || code === 'ROOM_FULL' || code === 'BAD_PASSWORD')) {
    await forgetRoom(requestId.slice(7));
    return;
  }
  pendingSecrets.delete(requestId);
  if (requestId.startsWith('voice:')) usePulse.getState().set({ voice: null });
  toast(message, 'error');
}

function updateMessage(clientMessageId: string, fn: (m: LocalMessage) => LocalMessage): void {
  store().set((st) => {
    const next = { ...st.messages };
    for (const roomId of Object.keys(next)) {
      const i = next[roomId].findIndex((m) => m.clientMessageId === clientMessageId);
      if (i === -1) continue;
      const updated = fn(next[roomId][i]);
      next[roomId] = next[roomId].slice();
      next[roomId][i] = updated;
      void putMessage(updated);
    }
    return { messages: next };
  });
}

async function receiveChat(payload: Extract<ServerMessage, { type: 'chat.message' }>['payload']): Promise<void> {
  const { enc, image, text, ...meta } = payload;
  let body: { text: string; image?: ImageAttachment } = { text, ...(image ? { image } : {}) };
  if (enc) {
    const secret = secretFor(payload.roomId);
    try {
      if (!secret) throw new Error('no key');
      body = await decryptBody(secret, payload.roomId, enc);
    } catch {
      body = { text: '🔒 Could not decrypt this message' };
    }
  }
  const message: LocalMessage = { ...meta, ...body, ...(enc ? { encrypted: true } : {}), state: 'sent' };
  inFlight.delete(payload.clientMessageId);
  await removeOutbox(payload.clientMessageId);
  await putMessage(message);
  store().set((st) => {
    const list = st.messages[payload.roomId] ?? [];
    const i = list.findIndex((m) => m.clientMessageId === payload.clientMessageId);
    const next = i === -1 ? [...list, message].slice(-HISTORY_LIMIT) : list.map((m, j) => (j === i ? message : m));
    return { messages: { ...st.messages, [payload.roomId]: next } };
  });
}

/* ------------------------------------------------------------------ outbound actions */

async function flushOutbox(): Promise<void> {
  if (!authed) return;
  const joined = new Set(store().joined.map((r) => r.id));
  for (const item of await outboxItems()) {
    if (inFlight.has(item.clientMessageId) || !joined.has(item.roomId)) continue;
    const secret = secretFor(item.roomId);
    const body = secret
      ? { text: '', enc: await encryptBody(secret, item.roomId, { text: item.text, ...(item.image ? { image: item.image } : {}) }) }
      : { text: item.text, ...(item.image ? { image: item.image } : {}) };
    if (inFlight.has(item.clientMessageId)) continue; // a concurrent flush got here first while we were encrypting
    if (send({ type: 'chat.send', requestId: `chat:${item.clientMessageId}`, payload: { roomId: item.roomId, clientMessageId: item.clientMessageId, ...body } })) inFlight.add(item.clientMessageId);
  }
}

/** Optimistic send: stored locally and queued; delivered now or when back online. Encrypted at send time in locked rooms. */
export async function sendChat(roomId: string, text: string, image?: ImageAttachment): Promise<void> {
  const { identity, profile } = store();
  if (!identity || !profile || (!text.trim() && !image)) return;
  const clientMessageId = crypto.randomUUID();
  const message: LocalMessage = { id: clientMessageId, clientMessageId, roomId, text, ...(image ? { image } : {}), ...(secretFor(roomId) ? { encrypted: true } : {}), author: { publicKey: identity.publicKeySpki, handle: profile.handle }, sentAt: Date.now(), state: 'pending' };
  await putMessage(message);
  store().set((st) => ({ messages: { ...st.messages, [roomId]: [...(st.messages[roomId] ?? []), message].slice(-HISTORY_LIMIT) } }));
  await queueOutbox({ clientMessageId, roomId, text, ...(image ? { image } : {}), queuedAt: Date.now() });
  void flushOutbox();
}

export async function retryMessage(m: LocalMessage): Promise<void> {
  updateMessage(m.clientMessageId, (x) => ({ ...x, state: 'pending', error: undefined }));
  await queueOutbox({ clientMessageId: m.clientMessageId, roomId: m.roomId, text: m.text, ...(m.image ? { image: m.image } : {}), queuedAt: Date.now() });
  void flushOutbox();
}

/**
 * Join (or open) a room. Locked rooms need the password: it's turned into a join proof and a decryption key on this
 * device. Returns false if a password is required but missing.
 */
export async function joinRoom(roomId: string, password?: string): Promise<boolean> {
  if (store().joined.some((r) => r.id === roomId)) { store().set({ activeRoom: roomId, dialog: null }); return true; }
  const room = store().directory.find((r) => r.id === roomId);
  const requestId = `user:${roomId}:${crypto.randomUUID().slice(0, 8)}`;
  let proof: string | undefined;
  if (room?.locked) {
    if (!password || !room.keySalt) return false;
    const secret = await deriveRoomSecret(password, room.keySalt);
    pendingSecrets.set(requestId, secret);
    proof = secret.proof;
  }
  if (!send({ type: 'room.join', requestId, payload: { roomId, ...(proof ? { proof } : {}) } })) { pendingSecrets.delete(requestId); toast('You are offline', 'error'); return true; }
  // Locked rooms keep the dialog open until the server accepts the password (room.joined closes it).
  if (!room?.locked) store().set({ dialog: null });
  return true;
}

export function leaveRoom(roomId: string): void {
  if (!send({ type: 'room.leave', requestId: `leave:${roomId}`, payload: { roomId } })) void forgetRoom(roomId);
}

/** Creates a room; with a password it is locked and end-to-end encrypted. */
export async function createRoom(settings: RoomSettings, password?: string): Promise<boolean> {
  const requestId = `user:create:${crypto.randomUUID()}`;
  let lock: { salt: string; proof: string } | undefined;
  if (password) {
    const salt = newSalt();
    const secret = await deriveRoomSecret(password, salt);
    pendingSecrets.set(requestId, secret);
    lock = { salt, proof: secret.proof };
  }
  const ok = send({ type: 'room.create', requestId, payload: { ...settings, ...(lock ? { lock } : {}) } });
  if (!ok) pendingSecrets.delete(requestId);
  return ok;
}

export function pinRoom(roomId: string, pinned: boolean): void {
  if (!send({ type: 'room.pin', requestId: `pin:${roomId}`, payload: { roomId, pinned } })) toast('You are offline', 'error');
}

export function refreshDirectory(): void { send({ type: 'room.list', requestId: 'list' }); }

export async function updateProfile(patch: Partial<{ handle: string; bio: string; status: Status }>): Promise<void> {
  const current = store().profile;
  if (!current) return;
  const profile = { ...current, ...patch };
  store().set({ profile });
  await setKv('profile', profile);
  if (patch.handle && patch.handle !== current.handle) send({ type: 'profile.update', requestId: 'profile', payload: { handle: patch.handle } });
  if (patch.status && patch.status !== current.status) send({ type: 'presence.update', requestId: 'status', payload: { status: patch.status } });
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const settings = { ...store().settings, ...patch };
  store().set({ settings });
  await setKv('settings', settings);
}
