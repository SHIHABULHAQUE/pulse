import { describe, expect, it, beforeEach } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeServer, encode, type ClientMessage, type ServerMessage } from '@pulse/protocol';
import { KeyedLimiter, TokenBucket } from './rateLimit';
import { RoomRegistry, slugify } from './rooms';
import { Hub, type Conn } from './hub';

describe('token bucket rate limiter', () => {
  it('allows a burst then reports wait time', () => {
    let t = 0;
    const b = new TokenBucket(3, 1, () => t);
    expect([b.take(), b.take(), b.take()]).toEqual([0, 0, 0]);
    expect(b.take()).toBe(1000);
    t = 1000;
    expect(b.take()).toBe(0);
  });

  it('never refills above capacity', () => {
    let t = 0;
    const b = new TokenBucket(2, 10, () => t);
    t = 60_000;
    expect([b.take(), b.take(), b.take()]).toEqual([0, 0, 100]);
  });

  it('keys are independent and idle buckets are swept', () => {
    let t = 0;
    const l = new KeyedLimiter({ chat: { capacity: 1, refillPerSec: 1 } }, () => t);
    expect(l.take('a', 'chat')).toBe(0);
    expect(l.take('a', 'chat')).toBeGreaterThan(0);
    expect(l.take('b', 'chat')).toBe(0);
    t = 5000;
    l.sweep();
    expect(l.size).toBe(0);
  });
});

describe('room registry', () => {
  it('slugifies names into valid ids', () => {
    expect(slugify('Kochi Coffee ☕ Club!')).toMatch(/^kochi-coffee-club-[a-f0-9]{6}$/);
    expect(slugify('☕')).toMatch(/^room-[a-f0-9]{6}$/);
  });

  it('expires empty unpinned rooms but keeps pinned and the lobby', () => {
    let t = 0;
    const r = new RoomRegistry({ dataDir: null, idleMs: 1000, debounceMs: 0, now: () => t });
    const a = r.create({ name: 'a', topic: '', emoji: '#', mode: 'text', memberCap: 10, slowModeSec: 0, rules: '' }, 'k'.repeat(44));
    const b = r.create({ name: 'b', topic: '', emoji: '#', mode: 'text', memberCap: 10, slowModeSec: 0, rules: '' }, 'k'.repeat(44));
    r.setPinned(b.id, true);
    t = 5000;
    expect(r.sweep()).toEqual([{ id: a.id, kind: 'public' }]);
    expect(r.view(b.id)).not.toBeNull();
    expect(r.view('lobby')).not.toBeNull();
  });

  it('snapshots only pinned public room definitions, atomically, and reloads them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-'));
    const r = new RoomRegistry({ dataDir: dir, idleMs: 1000, debounceMs: 0 });
    const pinned = r.create({ name: 'Pinned', topic: 't', emoji: '#', mode: 'text', memberCap: 10, slowModeSec: 0, rules: '' }, 'k'.repeat(44));
    r.create({ name: 'Loose', topic: '', emoji: '#', mode: 'text', memberCap: 10, slowModeSec: 0, rules: '' }, 'k'.repeat(44));
    r.setPinned(pinned.id, true);
    r.addMember(pinned.id, 's1');
    await r.saveNow();
    expect(existsSync(join(dir, 'rooms.json.tmp'))).toBe(false);
    const saved = JSON.parse(readFileSync(join(dir, 'rooms.json'), 'utf8'));
    expect(saved.rooms.map((x: { id: string }) => x.id)).toEqual([pinned.id]);
    expect(saved.rooms[0]).not.toHaveProperty('members');
    const fresh = new RoomRegistry({ dataDir: dir, idleMs: 1000, debounceMs: 0 });
    expect(await fresh.load()).toBe(1);
    expect(fresh.view(pinned.id)?.name).toBe('Pinned');
  });
});

/* ------------------------------------------------------------------ hub */

class FakeConn implements Conn {
  out: ServerMessage[] = [];
  open = true;
  bufferedAmount = 0;
  closed: number | null = null;
  send(text: string) { this.out.push(decodeServer(text)); }
  close(code: number) { this.closed = code; this.open = false; }
  last<T extends ServerMessage['type']>(type: T) { return [...this.out].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined; }
}

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), key: privateKey };
}
const sign = (key: KeyObject, challenge: string) => { const s = createSign('SHA256'); s.update(challenge); s.end(); return s.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64'); };

describe('hub', () => {
  let t: number;
  let hub: Hub;
  const log = { info: () => undefined, warn: () => undefined };
  beforeEach(() => {
    t = 1_000_000;
    hub = new Hub(new RoomRegistry({ dataDir: null, idleMs: 60_000, debounceMs: 0, now: () => t }), { maxBufferedBytes: 1000, log, now: () => t });
  });

  const send = (id: string, m: ClientMessage) => hub.handle(id, encode(m));
  function login(handle = 'ana', resumeToken?: string, who = identity()) {
    const conn = new FakeConn();
    const id = hub.connect(conn);
    const challenge = conn.last('server.challenge')!.payload.challenge;
    send(id, { type: 'client.hello', requestId: 'h', payload: { publicKey: who.pub, signature: sign(who.key, challenge), handle, ...(resumeToken ? { resumeToken } : {}) } });
    return { conn, id, who };
  }

  it('rejects a bad signature and closes the socket', () => {
    const conn = new FakeConn();
    const id = hub.connect(conn);
    const who = identity();
    send(id, { type: 'client.hello', requestId: 'h', payload: { publicKey: who.pub, signature: sign(who.key, 'not-the-challenge'), handle: 'ana' } });
    expect(conn.last('server.error')?.payload.code).toBe('AUTH_FAILED');
    expect(conn.closed).toBe(1008);
  });

  it('rejects an expired challenge', () => {
    const conn = new FakeConn();
    const id = hub.connect(conn);
    const challenge = conn.last('server.challenge')!.payload.challenge;
    t += 61_000;
    const who = identity();
    send(id, { type: 'client.hello', requestId: 'h', payload: { publicKey: who.pub, signature: sign(who.key, challenge), handle: 'ana' } });
    expect(conn.last('server.error')?.payload.code).toBe('AUTH_FAILED');
  });

  it('requires the handshake before other messages', () => {
    const conn = new FakeConn();
    const id = hub.connect(conn);
    send(id, { type: 'room.list', requestId: 'r' });
    expect(conn.last('server.error')?.payload.code).toBe('NOT_AUTHENTICATED');
  });

  it('relays chat only to room members and requires membership', () => {
    const a = login('ana');
    const b = login('ben');
    send(a.id, { type: 'chat.send', requestId: 'c', payload: { roomId: 'lobby', text: 'hi', clientMessageId: 'm1' } });
    expect(a.conn.last('server.error')?.payload.code).toBe('NOT_IN_ROOM');
    send(a.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    send(a.id, { type: 'chat.send', requestId: 'c', payload: { roomId: 'lobby', text: 'hi', clientMessageId: 'm1' } });
    expect(a.conn.last('chat.message')?.payload).toMatchObject({ text: 'hi', clientMessageId: 'm1', author: { handle: 'ana' } });
    expect(b.conn.last('chat.message')).toBeUndefined();
  });

  it('creates rooms, lists them by activity, and enforces slow mode for non-owners', () => {
    const owner = login('owner');
    send(owner.id, { type: 'room.create', requestId: 'r', payload: { name: 'Slow', topic: '', emoji: '#', mode: 'text', memberCap: 10, slowModeSec: 30, rules: '' } });
    const room = owner.conn.last('room.joined')!.payload;
    expect(room.ownerKey).toBe(owner.who.pub);
    const guest = login('guest');
    send(guest.id, { type: 'room.join', requestId: 'j', payload: { roomId: room.id } });
    send(guest.id, { type: 'chat.send', requestId: 'c1', payload: { roomId: room.id, text: 'one', clientMessageId: 'a' } });
    send(guest.id, { type: 'chat.send', requestId: 'c2', payload: { roomId: room.id, text: 'two', clientMessageId: 'b' } });
    expect(guest.conn.last('server.error')?.payload.code).toBe('SLOW_MODE');
    send(owner.id, { type: 'chat.send', requestId: 'c3', payload: { roomId: room.id, text: 'o1', clientMessageId: 'c' } });
    send(owner.id, { type: 'chat.send', requestId: 'c4', payload: { roomId: room.id, text: 'o2', clientMessageId: 'd' } });
    expect(owner.conn.out.filter((m) => m.type === 'chat.message' && m.payload.author.handle === 'owner')).toHaveLength(2);
    send(guest.id, { type: 'room.list', requestId: 'l' });
    expect(guest.conn.last('room.listed')!.payload.rooms[0].id).toBe(room.id);
  });

  it('enforces member caps and owner-only pinning', () => {
    const owner = login('owner');
    send(owner.id, { type: 'room.create', requestId: 'r', payload: { name: 'Tiny', topic: '', emoji: '#', mode: 'text', memberCap: 2, slowModeSec: 0, rules: '' } });
    const room = owner.conn.last('room.joined')!.payload;
    const b = login('ben');
    const c = login('cat');
    send(b.id, { type: 'room.join', requestId: 'j', payload: { roomId: room.id } });
    send(c.id, { type: 'room.join', requestId: 'j', payload: { roomId: room.id } });
    expect(c.conn.last('server.error')?.payload.code).toBe('ROOM_FULL');
    send(b.id, { type: 'room.pin', requestId: 'p', payload: { roomId: room.id, pinned: true } });
    expect(b.conn.last('server.error')?.payload.code).toBe('FORBIDDEN');
    send(owner.id, { type: 'room.pin', requestId: 'p', payload: { roomId: room.id, pinned: true } });
    expect(owner.conn.last('room.updated')?.payload.pinned).toBe(true);
  });

  it('resumes rooms and status within the grace period for the same identity only', () => {
    const a = login('ana');
    send(a.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    send(a.id, { type: 'presence.update', requestId: 'p', payload: { status: 'dnd' } });
    const token = a.conn.last('server.ready')!.payload.resumeToken;
    hub.disconnect(a.id);
    const stranger = login('eve', token);
    expect(stranger.conn.last('server.ready')!.payload.resumed).toBe(false);
    // token was consumed by the failed attempt; a real client gets a fresh one per session
    const b = login('ana');
    send(b.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    const token2 = b.conn.last('server.ready')!.payload.resumeToken;
    hub.disconnect(b.id);
    t += 30_000;
    const again = login('ana', token2, b.who);
    expect(again.conn.last('server.ready')!.payload).toMatchObject({ resumed: true, joinedRooms: ['lobby'] });
  });

  it('expires resume tokens after the grace period', () => {
    const a = login('ana');
    const token = a.conn.last('server.ready')!.payload.resumeToken;
    hub.disconnect(a.id);
    t += 61_000;
    hub.sweep();
    expect(login('ana', token, a.who).conn.last('server.ready')!.payload.resumed).toBe(false);
  });

  it('rate limits chat floods', () => {
    const a = login('ana');
    send(a.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    for (let i = 0; i < 20; i++) send(a.id, { type: 'chat.send', requestId: `c${i}`, payload: { roomId: 'lobby', text: 'spam', clientMessageId: `m${i}` } });
    expect(a.conn.out.filter((m) => m.type === 'server.error' && m.payload.code === 'RATE_LIMITED').length).toBeGreaterThan(0);
  });

  it('hides invisible users from presence and drops frames under backpressure', () => {
    const a = login('ana');
    const b = login('ben');
    send(a.id, { type: 'presence.update', requestId: 'p', payload: { status: 'invisible' } });
    expect(b.conn.last('presence.snapshot')!.payload.map((p) => p.handle)).toEqual(['ben']);
    b.conn.bufferedAmount = 10_000;
    const before = b.conn.out.length;
    send(a.id, { type: 'presence.update', requestId: 'p', payload: { status: 'online' } });
    expect(b.conn.out.length).toBe(before);
  });

  it('rejects malformed frames', () => {
    const a = login('ana');
    hub.handle(a.id, '{"v":1,"type":"chat.send","requestId":"x","payload":{"roomId":"lobby"}}');
    hub.handle(a.id, 'not json');
    expect(a.conn.out.filter((m) => m.type === 'server.error' && m.payload.code === 'INVALID_MESSAGE')).toHaveLength(2);
  });
});

describe('locked rooms, images and voice', () => {
  let t: number;
  let hub: Hub;
  const log = { info: () => undefined, warn: () => undefined };
  beforeEach(() => {
    t = 1_000_000;
    hub = new Hub(new RoomRegistry({ dataDir: null, idleMs: 60_000, debounceMs: 0, now: () => t }), { maxBufferedBytes: 10_000_000, log, now: () => t, iceServers: () => [{ urls: 'stun:example.org' }] });
  });
  const send = (id: string, m: ClientMessage) => hub.handle(id, encode(m));
  function login(handle: string) {
    const conn = new FakeConn();
    const id = hub.connect(conn);
    const who = identity();
    send(id, { type: 'client.hello', requestId: 'h', payload: { publicKey: who.pub, signature: sign(who.key, conn.last('server.challenge')!.payload.challenge), handle } });
    return { conn, id };
  }
  const settings = { name: 'Secret', topic: '', emoji: '#', mode: 'both' as const, memberCap: 10, slowModeSec: 0, rules: '' };
  const lock = { salt: 'c2FsdHNhbHRzYWx0c2FsdA', proof: 'cHJvb2Zwcm9vZnByb29mcHJvb2Zwcm9vZnByb29mcHI' };
  const enc = { iv: 'aXZpdml2aXZpdml2', ct: 'Y2lwaGVydGV4dA' };
  const image = { mime: 'image/webp' as const, data: 'UklGRg', width: 10, height: 10 };

  it('requires the right password proof to join a locked room and never exposes the verifier', () => {
    const owner = login('owner');
    send(owner.id, { type: 'room.create', requestId: 'c', payload: { ...settings, lock } });
    const room = owner.conn.last('room.joined')!.payload;
    expect(room).toMatchObject({ locked: true, keySalt: lock.salt });
    expect(JSON.stringify(room)).not.toContain(lock.proof);
    expect(room).not.toHaveProperty('passwordHash');
    const guest = login('guest');
    send(guest.id, { type: 'room.join', requestId: 'j1', payload: { roomId: room.id } });
    expect(guest.conn.last('server.error')?.payload.code).toBe('BAD_PASSWORD');
    send(guest.id, { type: 'room.join', requestId: 'j2', payload: { roomId: room.id, proof: 'd3Jvbmd3cm9uZ3dyb25nd3Jvbmd3cm9uZ3dyb25nd3I' } });
    expect(guest.conn.last('server.error')?.payload.message).toBe('Wrong password');
    send(guest.id, { type: 'room.join', requestId: 'j3', payload: { roomId: room.id, proof: lock.proof } });
    expect(guest.conn.last('room.joined')?.payload.id).toBe(room.id);
  });

  it('refuses plaintext in locked rooms and ciphertext in open rooms, and relays ciphertext untouched', () => {
    const owner = login('owner');
    send(owner.id, { type: 'room.create', requestId: 'c', payload: { ...settings, lock } });
    const room = owner.conn.last('room.joined')!.payload;
    send(owner.id, { type: 'chat.send', requestId: 'p', payload: { roomId: room.id, text: 'oops plaintext', clientMessageId: 'a' } });
    expect(owner.conn.last('server.error')?.payload.code).toBe('ENCRYPTION_REQUIRED');
    send(owner.id, { type: 'chat.send', requestId: 'e', payload: { roomId: room.id, text: '', enc, clientMessageId: 'b' } });
    expect(owner.conn.last('chat.message')?.payload).toMatchObject({ text: '', enc });
    send(owner.id, { type: 'room.join', requestId: 'l', payload: { roomId: 'lobby' } });
    send(owner.id, { type: 'chat.send', requestId: 'e2', payload: { roomId: 'lobby', text: '', enc, clientMessageId: 'c' } });
    expect(owner.conn.last('server.error')?.payload.code).toBe('ENCRYPTION_REQUIRED');
  });

  it('relays image messages, rejects empty ones, and rate limits image floods', () => {
    const a = login('ana');
    send(a.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    send(a.id, { type: 'chat.send', requestId: 'x', payload: { roomId: 'lobby', text: '   ', clientMessageId: 'empty' } });
    expect(a.conn.last('server.error')?.payload.code).toBe('INVALID_MESSAGE');
    send(a.id, { type: 'chat.send', requestId: 'i', payload: { roomId: 'lobby', text: 'look', image, clientMessageId: 'img0' } });
    expect(a.conn.last('chat.message')?.payload.image).toEqual(image);
    for (let n = 1; n < 10; n++) send(a.id, { type: 'chat.send', requestId: 'i' + n, payload: { roomId: 'lobby', text: '', image, clientMessageId: 'img' + n } });
    expect(a.conn.out.some((m) => m.type === 'server.error' && m.payload.code === 'RATE_LIMITED')).toBe(true);
  });

  it('voice: join gives ICE servers, state is shared with the room, text-only rooms refuse', () => {
    const a = login('ana');
    const b = login('ben');
    send(a.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    send(b.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    send(a.id, { type: 'voice.join', requestId: 'v', payload: { roomId: 'lobby', muted: false } });
    expect(a.conn.last('voice.joined')?.payload).toMatchObject({ roomId: 'lobby', sessionId: a.id, iceServers: [{ urls: 'stun:example.org' }] });
    expect(b.conn.last('voice.state')?.payload.participants.map((p) => p.handle)).toEqual(['ana']);
    send(a.id, { type: 'voice.mute', requestId: 'm', payload: { muted: true } });
    expect(b.conn.last('voice.state')?.payload.participants[0].muted).toBe(true);
    send(a.id, { type: 'room.create', requestId: 'c', payload: { ...settings, mode: 'text' } });
    const textRoom = a.conn.last('room.joined')!.payload;
    send(a.id, { type: 'voice.join', requestId: 'v2', payload: { roomId: textRoom.id, muted: false } });
    expect(a.conn.last('server.error')?.payload.code).toBe('VOICE_DISABLED');
  });

  it('relays WebRTC signals only between two sessions in the same voice channel', () => {
    const a = login('ana');
    const b = login('ben');
    const c = login('cat');
    for (const s of [a, b, c]) send(s.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    send(a.id, { type: 'voice.join', requestId: 'v', payload: { roomId: 'lobby', muted: false } });
    send(a.id, { type: 'rtc.signal', requestId: 's0', payload: { to: b.id, description: { type: 'offer', sdp: 'v=0' } } });
    expect(a.conn.last('server.error')?.payload.code).toBe('NOT_IN_VOICE');
    send(b.id, { type: 'voice.join', requestId: 'v', payload: { roomId: 'lobby', muted: false } });
    send(a.id, { type: 'rtc.signal', requestId: 's1', payload: { to: b.id, description: { type: 'offer', sdp: 'v=0' } } });
    expect(b.conn.last('rtc.signal')?.payload).toMatchObject({ from: a.id, description: { type: 'offer', sdp: 'v=0' } });
    send(c.id, { type: 'rtc.signal', requestId: 's2', payload: { to: a.id, candidate: { candidate: 'x' } } });
    expect(c.conn.last('server.error')?.payload.code).toBe('NOT_IN_VOICE');
    hub.disconnect(b.id);
    expect(a.conn.last('voice.state')?.payload.participants.map((p) => p.handle)).toEqual(['ana']);
  });

  it('caps voice channels at the mesh limit', () => {
    const people = Array.from({ length: 9 }, (_, i) => login('p' + i));
    for (const p of people) {
      send(p.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
      send(p.id, { type: 'voice.join', requestId: 'v', payload: { roomId: 'lobby', muted: false } });
    }
    expect(people[8].conn.last('server.error')?.payload.code).toBe('VOICE_FULL');
  });
});

describe('TURN credentials', () => {
  it('issues expiring HMAC credentials with a shared secret and never leaks the secret', async () => {
    const { iceServersFor } = await import('./turn');
    const { createHmac } = await import('node:crypto');
    const cfg = { stunUrls: ['stun:s'], turnUrls: ['turn:t:3478'], turnSecret: 'sekret', turnUsername: '', turnCredential: '', turnTtlSec: 3600 };
    const [stun, turn] = iceServersFor('abc', cfg, 1_000_000);
    expect(stun).toEqual({ urls: ['stun:s'] });
    expect(turn.username).toBe('4600:abc');
    expect(turn.credential).toBe(createHmac('sha1', 'sekret').update('4600:abc').digest('base64'));
    expect(JSON.stringify(turn)).not.toContain('sekret');
    expect(iceServersFor('x', { ...cfg, turnSecret: '', turnUsername: 'u', turnCredential: 'p' })[1]).toMatchObject({ username: 'u', credential: 'p' });
    expect(iceServersFor('x', { ...cfg, turnSecret: '' })).toHaveLength(1);
  });
});

describe('private rooms', () => {
  let hub: Hub;
  const log = { info: () => undefined, warn: () => undefined };
  beforeEach(() => { hub = new Hub(new RoomRegistry({ dataDir: null, idleMs: 60_000, debounceMs: 0 }), { maxBufferedBytes: 10_000_000, log }); });
  const send = (id: string, m: ClientMessage) => hub.handle(id, encode(m));
  function login(handle: string, resumeToken?: string, who = identity()) {
    const conn = new FakeConn();
    const id = hub.connect(conn);
    send(id, { type: 'client.hello', requestId: 'h', payload: { publicKey: who.pub, signature: sign(who.key, conn.last('server.challenge')!.payload.challenge), handle, ...(resumeToken ? { resumeToken } : {}) } });
    return { conn, id, who };
  }
  const settings = { name: 'Family', topic: '', emoji: '#', mode: 'both' as const, memberCap: 10, slowModeSec: 0, rules: '' };
  const lock = { salt: 'c2FsdHNhbHRzYWx0c2FsdA', proof: 'cHJvb2Zwcm9vZnByb29mcHJvb2Zwcm9vZnByb29mcHI' };
  const mentions = (conn: FakeConn, text: string) => conn.out.some((m) => JSON.stringify(m).includes(text));

  it('requires end-to-end encryption', () => {
    const a = login('ana');
    send(a.id, { type: 'room.create', requestId: 'c', payload: { ...settings, private: true } });
    expect(a.conn.last('server.error')?.payload.code).toBe('INVALID_MESSAGE');
  });

  it('is never listed, announced or leaked through presence to non-members', () => {
    const outsider = login('eve');
    send(outsider.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    const owner = login('ana');
    send(owner.id, { type: 'room.join', requestId: 'j', payload: { roomId: 'lobby' } });
    send(owner.id, { type: 'room.create', requestId: 'c', payload: { ...settings, name: 'Secret Family', lock, private: true } });
    const room = owner.conn.last('room.joined')!.payload;
    expect(room.kind).toBe('private');
    send(owner.id, { type: 'room.pin', requestId: 'p', payload: { roomId: room.id, pinned: true } });
    send(outsider.id, { type: 'room.list', requestId: 'l' });
    expect(outsider.conn.last('room.listed')!.payload.rooms.map((r) => r.id)).toEqual(['lobby']);
    // Nothing the outsider received mentions the room's id or name.
    expect(mentions(outsider.conn, room.id)).toBe(false);
    expect(mentions(outsider.conn, 'Secret Family')).toBe(false);
    // Owner still sees it in their own presence.
    expect(owner.conn.last('presence.snapshot')!.payload.find((p) => p.handle === 'ana')!.rooms).toContain(room.id);
  });

  it('members can join with the proof from the invite, and see each other in presence', () => {
    const owner = login('ana');
    send(owner.id, { type: 'room.create', requestId: 'c', payload: { ...settings, lock, private: true } });
    const room = owner.conn.last('room.joined')!.payload;
    const guest = login('ben');
    send(guest.id, { type: 'room.join', requestId: 'j0', payload: { roomId: room.id } });
    expect(guest.conn.last('server.error')?.payload.code).toBe('BAD_PASSWORD');
    send(guest.id, { type: 'room.join', requestId: 'j1', payload: { roomId: room.id, proof: lock.proof } });
    expect(guest.conn.last('room.joined')?.payload.id).toBe(room.id);
    expect(guest.conn.last('presence.snapshot')!.payload.find((p) => p.handle === 'ana')!.rooms).toContain(room.id);
  });

  it('a resumed member gets the private room back in server.ready', () => {
    const owner = login('ana');
    send(owner.id, { type: 'room.create', requestId: 'c', payload: { ...settings, lock, private: true } });
    const room = owner.conn.last('room.joined')!.payload;
    const token = owner.conn.last('server.ready')!.payload.resumeToken;
    hub.disconnect(owner.id);
    const back = login('ana', token, owner.who);
    const ready = back.conn.last('server.ready')!.payload;
    expect(ready.joinedRooms).toContain(room.id);
    expect(ready.rooms.map((r) => r.id)).toContain(room.id);
  });

  it('is not written to rooms.json even when pinned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-'));
    const reg = new RoomRegistry({ dataDir: dir, idleMs: 1000, debounceMs: 0 });
    const priv = reg.create(settings, 'k'.repeat(44), lock, 'private');
    reg.setPinned(priv.id, true);
    await reg.saveNow();
    expect(JSON.parse(readFileSync(join(dir, 'rooms.json'), 'utf8')).rooms).toEqual([]);
  });
});
