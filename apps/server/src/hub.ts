import { createVerify, randomBytes, randomUUID } from 'node:crypto';
import {
  LIMITS, bodyKind, decodeClient, encode,
  type ClientMessage, type ErrorCode, type IceServer, type Presence, type ServerMessage, type Status, type VoiceParticipant
} from '@pulse/protocol';
import { KeyedLimiter, connectionLimits, keyLimits, type Action } from './rateLimit.js';
import { LOBBY_ID, RoomRegistry } from './rooms.js';

/** Minimal transport so the hub can be tested without real sockets. */
export interface Conn {
  send(text: string): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
  readonly open: boolean;
}

export interface Logger { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }

type Session = {
  id: string;
  conn: Conn;
  publicKey: string;
  handle: string;
  status: Status;
  rooms: Set<string>;
  challenge: string;
  challengeExpiresAt: number;
  ready: boolean;
  resumeToken: string;
  lastSendByRoom: Map<string, number>;
  /** Room whose voice channel this session is in (one at a time). */
  voiceRoom: string | null;
  muted: boolean;
};

/** What survives a dropped connection for the resume grace period. */
type Parked = { publicKey: string; handle: string; status: Status; rooms: string[]; expiresAt: number };

export const metrics = {
  connectionsTotal: 0,
  messagesRelayedTotal: 0,
  rateLimitedTotal: 0,
  invalidMessagesTotal: 0,
  authFailuresTotal: 0,
  resumesTotal: 0,
  droppedBackpressureTotal: 0,
  imagesRelayedTotal: 0,
  voiceJoinsTotal: 0,
  signalsRelayedTotal: 0
};

export class Hub {
  readonly sessions = new Map<string, Session>();
  private readonly parked = new Map<string, Parked>();
  private readonly connLimiter = new KeyedLimiter<Action>(connectionLimits);
  private readonly keyLimiter = new KeyedLimiter<Action>(keyLimits);

  constructor(readonly rooms: RoomRegistry, private readonly opts: { maxBufferedBytes: number; log: Logger; now?: () => number; iceServers?: (label: string) => IceServer[] }) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  /* ---------------------------------------------------------------- lifecycle */

  connect(conn: Conn): string {
    metrics.connectionsTotal += 1;
    const challenge = randomBytes(32).toString('base64url');
    const session: Session = {
      id: randomUUID(), conn, publicKey: '', handle: '', status: 'online', rooms: new Set(), challenge,
      challengeExpiresAt: this.now() + LIMITS.challengeTtlMs, ready: false, resumeToken: '', lastSendByRoom: new Map(), voiceRoom: null, muted: false
    };
    this.sessions.set(session.id, session);
    this.send(session, { type: 'server.challenge', requestId: 'handshake', payload: { challenge, expiresAt: session.challengeExpiresAt } });
    return session.id;
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.leaveVoice(session, 'disconnect');
    this.sessions.delete(sessionId);
    if (!session.ready) return;
    this.parked.set(session.resumeToken, { publicKey: session.publicKey, handle: session.handle, status: session.status, rooms: [...session.rooms], expiresAt: this.now() + LIMITS.resumeGraceMs });
    for (const roomId of session.rooms) { this.rooms.removeMember(roomId, session.id); this.broadcastRoom(roomId); }
    this.broadcastPresence();
  }

  /** Periodic housekeeping: expired resume tokens, idle rooms, idle limiter buckets. */
  sweep(): void {
    const now = this.now();
    for (const [token, parked] of this.parked) if (parked.expiresAt <= now) this.parked.delete(token);
    // Private rooms are only removed when empty, so there is nobody to tell (and nobody else may learn they existed).
    for (const room of this.rooms.sweep()) if (room.kind === 'public') this.broadcastAll({ type: 'room.removed', requestId: 'sweep', payload: { roomId: room.id } });
    this.connLimiter.sweep();
    this.keyLimiter.sweep();
  }

  /* ---------------------------------------------------------------- transport helpers */

  private send(session: Session, message: ServerMessage): void {
    if (!session.conn.open) return;
    if (session.conn.bufferedAmount > this.opts.maxBufferedBytes) { metrics.droppedBackpressureTotal += 1; return; }
    session.conn.send(encode(message));
  }

  private error(session: Session, requestId: string, code: ErrorCode, message: string, retryAfterMs?: number): void {
    this.send(session, { type: 'server.error', requestId, payload: { code, message, ...(retryAfterMs ? { retryAfterMs } : {}) } });
  }

  private broadcastAll(message: ServerMessage): void {
    for (const s of this.sessions.values()) if (s.ready) this.send(s, message);
  }

  private broadcastToRoom(roomId: string, message: ServerMessage): void {
    for (const s of this.sessions.values()) if (s.ready && s.rooms.has(roomId)) this.send(s, message);
  }

  /** Public room updates go to everyone (directory); private room updates only to its members. */
  private broadcastRoom(roomId: string, requestId = 'room'): void {
    const room = this.rooms.view(roomId);
    if (!room) return;
    const message: ServerMessage = { type: 'room.updated', requestId, payload: room };
    if (room.kind === 'private') this.broadcastToRoom(roomId, message);
    else this.broadcastAll(message);
  }

  /** Public rooms plus the private rooms this session belongs to. */
  private roomsFor(session: Session): ReturnType<RoomRegistry['list']> {
    const rooms = this.rooms.list();
    for (const id of session.rooms) if (this.rooms.isPrivate(id)) rooms.push(this.rooms.view(id)!);
    return rooms;
  }

  /**
   * Who is online. Room lists are filtered for the viewer: public rooms, plus private rooms the viewer is also in,
   * so nobody learns which private rooms other people belong to.
   */
  presence(viewer?: { rooms: Set<string> }): Presence[] {
    const byKey = new Map<string, Presence>();
    const visible = (roomId: string) => !this.rooms.isPrivate(roomId) || (viewer?.rooms.has(roomId) ?? false);
    for (const s of this.sessions.values()) {
      if (!s.ready || s.status === 'invisible') continue;
      const rooms = [...s.rooms].filter(visible);
      const existing = byKey.get(s.publicKey);
      if (existing) { existing.rooms = [...new Set([...existing.rooms, ...rooms])]; continue; }
      byKey.set(s.publicKey, { publicKey: s.publicKey, handle: s.handle, status: s.status, rooms });
    }
    return [...byKey.values()];
  }

  private broadcastPresence(): void {
    for (const s of this.sessions.values()) if (s.ready) this.send(s, { type: 'presence.snapshot', requestId: 'presence', payload: this.presence(s) });
  }

  /** Both per-connection and per-identity buckets must allow the action. */
  private limited(session: Session, action: Action, requestId: string): boolean {
    const wait = Math.max(this.connLimiter.take(session.id, action), session.publicKey ? this.keyLimiter.take(session.publicKey, action) : 0);
    if (wait === 0) return false;
    metrics.rateLimitedTotal += 1;
    this.error(session, requestId, 'RATE_LIMITED', 'Too many requests; slow down', wait);
    return true;
  }

  /* ---------------------------------------------------------------- inbound */

  handle(sessionId: string, raw: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (this.limited(session, 'frame', 'unknown')) return;
    let message: ClientMessage;
    try { message = decodeClient(raw); } catch {
      metrics.invalidMessagesTotal += 1;
      this.error(session, 'unknown', 'INVALID_MESSAGE', 'Message failed validation');
      return;
    }
    if (message.type === 'client.hello') { this.hello(session, message); return; }
    if (!session.ready) { this.error(session, message.requestId, 'NOT_AUTHENTICATED', 'Complete the identity handshake first'); return; }

    switch (message.type) {
      case 'room.list':
        this.send(session, { type: 'room.listed', requestId: message.requestId, payload: { rooms: this.roomsFor(session) } });
        return;
      case 'presence.update':
        session.status = message.payload.status;
        this.broadcastPresence();
        return;
      case 'profile.update':
        if (this.limited(session, 'profile', message.requestId)) return;
        session.handle = message.payload.handle;
        this.broadcastPresence();
        return;
      case 'room.create': {
        if (this.limited(session, 'roomCreate', message.requestId)) return;
        if (session.rooms.size >= LIMITS.roomsPerSession) { this.error(session, message.requestId, 'TOO_MANY_ROOMS', `You can be in at most ${LIMITS.roomsPerSession} rooms`); return; }
        const { lock, private: isPrivate, ...settings } = message.payload;
        if (isPrivate && !lock) { this.error(session, message.requestId, 'INVALID_MESSAGE', 'Private rooms must be end-to-end encrypted'); return; }
        const room = this.rooms.create(settings, session.publicKey, lock, isPrivate ? 'private' : 'public');
        this.joinRoom(session, room.id, message.requestId, lock?.proof);
        return;
      }
      case 'room.join':
        if (this.limited(session, 'join', message.requestId)) return;
        this.joinRoom(session, message.payload.roomId, message.requestId, message.payload.proof);
        return;
      case 'room.leave': {
        const { roomId } = message.payload;
        if (!session.rooms.has(roomId)) return;
        if (session.voiceRoom === roomId) this.leaveVoice(session, message.requestId);
        session.rooms.delete(roomId);
        this.rooms.removeMember(roomId, session.id);
        this.send(session, { type: 'room.left', requestId: message.requestId, payload: { roomId } });
        this.broadcastRoom(roomId);
        this.broadcastPresence();
        return;
      }
      case 'room.pin': {
        const { roomId, pinned } = message.payload;
        if (this.rooms.ownerOf(roomId) !== session.publicKey) { this.error(session, message.requestId, 'FORBIDDEN', 'Only the room owner can pin it'); return; }
        if (this.rooms.setPinned(roomId, pinned)) this.broadcastRoom(roomId, message.requestId);
        return;
      }
      case 'chat.send': {
        const { roomId, text, image, enc, clientMessageId } = message.payload;
        if (!session.rooms.has(roomId)) { this.error(session, message.requestId, 'NOT_IN_ROOM', 'Join the room before sending'); return; }
        const room = this.rooms.view(roomId);
        if (!room) { this.error(session, message.requestId, 'ROOM_NOT_FOUND', 'Room no longer exists'); return; }
        const kind = bodyKind(message.payload);
        if (!kind) { this.error(session, message.requestId, 'INVALID_MESSAGE', 'A message needs text, an image, or ciphertext (not plaintext and ciphertext together)'); return; }
        // Locked rooms are end-to-end encrypted: refuse plaintext so a buggy client can't leak it. Open rooms stay plaintext so they can be moderated.
        if (room.locked !== (kind === 'encrypted')) { this.error(session, message.requestId, 'ENCRYPTION_REQUIRED', room.locked ? 'This room is end-to-end encrypted' : 'Open rooms do not accept encrypted messages'); return; }
        const heavy = !!image || (enc ? enc.ct.length > 8_000 : false);
        if (this.limited(session, heavy ? 'media' : 'chat', message.requestId)) return;
        const now = this.now();
        if (room.slowModeSec > 0 && room.ownerKey !== session.publicKey) {
          const last = session.lastSendByRoom.get(roomId) ?? 0;
          const wait = last + room.slowModeSec * 1000 - now;
          if (wait > 0) { this.error(session, message.requestId, 'SLOW_MODE', `Slow mode: wait ${Math.ceil(wait / 1000)}s`, wait); return; }
          session.lastSendByRoom.set(roomId, now);
        }
        this.rooms.touch(roomId);
        metrics.messagesRelayedTotal += 1;
        if (heavy) metrics.imagesRelayedTotal += 1;
        const body = kind === 'encrypted' ? { text: '', enc } : { text, ...(image ? { image } : {}) };
        this.broadcastToRoom(roomId, { type: 'chat.message', requestId: message.requestId, payload: { id: randomUUID(), clientMessageId, roomId, ...body, author: { publicKey: session.publicKey, handle: session.handle }, sentAt: now } });
        return;
      }
      case 'voice.join': {
        if (this.limited(session, 'voice', message.requestId)) return;
        const { roomId, muted } = message.payload;
        const room = this.rooms.view(roomId);
        if (!room || !session.rooms.has(roomId)) { this.error(session, message.requestId, 'NOT_IN_ROOM', 'Join the room first'); return; }
        if (room.mode === 'text') { this.error(session, message.requestId, 'VOICE_DISABLED', 'This room is text only'); return; }
        if (session.voiceRoom === roomId) return;
        if (this.voiceParticipants(roomId).length >= LIMITS.voicePerRoom) { this.error(session, message.requestId, 'VOICE_FULL', 'Voice is full (' + LIMITS.voicePerRoom + ' people max)'); return; }
        if (session.voiceRoom) this.leaveVoice(session, message.requestId);
        session.voiceRoom = roomId;
        session.muted = muted;
        metrics.voiceJoinsTotal += 1;
        this.send(session, { type: 'voice.joined', requestId: message.requestId, payload: { roomId, sessionId: session.id, iceServers: this.opts.iceServers?.(session.id.slice(0, 8)) ?? [] } });
        this.broadcastVoice(roomId);
        return;
      }
      case 'voice.leave':
        this.leaveVoice(session, message.requestId);
        return;
      case 'voice.mute':
        if (!session.voiceRoom) return;
        session.muted = message.payload.muted;
        this.broadcastVoice(session.voiceRoom);
        return;
      case 'rtc.signal': {
        if (this.limited(session, 'signal', message.requestId)) return;
        const { to, ...data } = message.payload;
        const peer = this.sessions.get(to);
        // Only relay between two sessions in the same voice channel: no arbitrary session-to-session messaging.
        if (!session.voiceRoom || !peer || peer.voiceRoom !== session.voiceRoom || peer.id === session.id) { this.error(session, message.requestId, 'NOT_IN_VOICE', 'That person is not in your voice channel'); return; }
        metrics.signalsRelayedTotal += 1;
        this.send(peer, { type: 'rtc.signal', requestId: 'rtc', payload: { ...data, from: session.id } });
        return;
      }
    }
  }

  private hello(session: Session, message: Extract<ClientMessage, { type: 'client.hello' }>): void {
    const { publicKey, signature, handle, resumeToken } = message.payload;
    if (session.ready || !this.verify(session, publicKey, signature)) {
      metrics.authFailuresTotal += 1;
      this.error(session, message.requestId, 'AUTH_FAILED', 'Challenge signature was invalid or expired');
      session.conn.close(1008, 'authentication failed');
      return;
    }
    session.publicKey = publicKey;
    session.handle = handle;
    session.ready = true;
    session.resumeToken = randomBytes(24).toString('base64url');

    // Resume: only honoured for the same identity within the grace window.
    let resumed = false;
    const parked = resumeToken ? this.parked.get(resumeToken) : undefined;
    if (resumeToken) this.parked.delete(resumeToken);
    if (parked && parked.publicKey === publicKey && parked.expiresAt > this.now()) {
      resumed = true;
      metrics.resumesTotal += 1;
      session.status = parked.status;
      for (const roomId of parked.rooms) {
        if (!this.rooms.view(roomId) || this.rooms.memberCount(roomId) >= this.rooms.view(roomId)!.memberCap) continue;
        session.rooms.add(roomId);
        this.rooms.addMember(roomId, session.id);
      }
    }

    this.send(session, { type: 'server.ready', requestId: message.requestId, payload: { sessionId: session.id, publicKey, resumeToken: session.resumeToken, resumed, joinedRooms: [...session.rooms], rooms: this.roomsFor(session) } });
    for (const roomId of session.rooms) this.broadcastRoom(roomId);
    this.broadcastPresence();
  }

  private verify(session: Session, publicKeyB64: string, signatureB64: string): boolean {
    if (this.now() > session.challengeExpiresAt) return false;
    try {
      const verifier = createVerify('SHA256');
      verifier.update(session.challenge);
      verifier.end();
      return verifier.verify({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureB64, 'base64'));
    } catch { return false; }
  }

  /* ---------------------------------------------------------------- voice */

  voiceParticipants(roomId: string): VoiceParticipant[] {
    const out: VoiceParticipant[] = [];
    for (const s of this.sessions.values()) if (s.ready && s.voiceRoom === roomId) out.push({ sessionId: s.id, publicKey: s.publicKey, handle: s.handle, muted: s.muted });
    return out;
  }

  /** Everyone in the room sees who is in its voice channel (so they can see it's active before joining). */
  private broadcastVoice(roomId: string): void {
    this.broadcastToRoom(roomId, { type: 'voice.state', requestId: 'voice', payload: { roomId, participants: this.voiceParticipants(roomId) } });
  }

  private leaveVoice(session: Session, requestId: string): void {
    const roomId = session.voiceRoom;
    if (!roomId) return;
    session.voiceRoom = null;
    session.muted = false;
    this.send(session, { type: 'voice.left', requestId, payload: { roomId } });
    this.broadcastVoice(roomId);
  }

  private joinRoom(session: Session, roomId: string, requestId: string, proof?: string): void {
    const room = this.rooms.view(roomId);
    if (!room) { this.error(session, requestId, 'ROOM_NOT_FOUND', 'Room not found'); return; }
    if (!session.rooms.has(roomId)) {
      if (!this.rooms.checkProof(roomId, proof)) { this.error(session, requestId, 'BAD_PASSWORD', proof ? 'Wrong password' : 'This room needs a password'); return; }
      if (session.rooms.size >= LIMITS.roomsPerSession) { this.error(session, requestId, 'TOO_MANY_ROOMS', `You can be in at most ${LIMITS.roomsPerSession} rooms`); return; }
      if (room.members >= room.memberCap) { this.error(session, requestId, 'ROOM_FULL', 'This room is full'); return; }
      session.rooms.add(roomId);
      this.rooms.addMember(roomId, session.id);
    }
    this.send(session, { type: 'room.joined', requestId, payload: this.rooms.view(roomId)! });
    this.send(session, { type: 'voice.state', requestId: 'voice', payload: { roomId, participants: this.voiceParticipants(roomId) } });
    this.broadcastRoom(roomId);
    this.broadcastPresence();
  }
}

export { LOBBY_ID };
