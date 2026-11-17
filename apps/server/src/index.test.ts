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
    expect(r.sweep()).toEqual([a.id]);
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
