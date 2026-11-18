import type { EncryptedBody, ImageAttachment } from '@pulse/protocol';
import { b64urlToBytes, bytesToB64url } from './b64';

/**
 * Locked rooms.
 *
 * From the password and the room's public salt we derive two *independent* 256-bit values with PBKDF2:
 *   proof = PBKDF2(password, "pulse-room-auth|" + salt)  → sent to the server, which stores only scrypt(proof)
 *   key   = PBKDF2(password, "pulse-room-key|"  + salt)  → AES-GCM key, never leaves devices
 * Knowing the proof (or its hash) does not reveal the key, so the server can gate joins but cannot read messages.
 */
export const ROOM_KDF_ITERATIONS = 310_000;

export type RoomSecret = { proof: string; key: string; invite?: string };
export type PlainBody = { text: string; image?: ImageAttachment };

export function newSalt(): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
}

async function pbkdf2(password: string, label: string, salt: string, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(`${label}|${salt}`), iterations }, material, 256);
  return new Uint8Array(bits);
}

export async function deriveRoomSecret(password: string, salt: string, iterations = ROOM_KDF_ITERATIONS): Promise<RoomSecret> {
  const [proof, key] = await Promise.all([pbkdf2(password, 'pulse-room-auth', salt, iterations), pbkdf2(password, 'pulse-room-key', salt, iterations)]);
  return { proof: bytesToB64url(proof), key: bytesToB64url(key) };
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function aesKey(rawB64: string): Promise<CryptoKey> {
  let key = keyCache.get(rawB64);
  if (!key) { key = crypto.subtle.importKey('raw', b64urlToBytes(rawB64), 'AES-GCM', false, ['encrypt', 'decrypt']); keyCache.set(rawB64, key); }
  return key;
}

/** The room id is bound as additional data so ciphertext can't be replayed into another room. */
export async function encryptBody(secret: RoomSecret, roomId: string, body: PlainBody): Promise<EncryptedBody> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(roomId) }, await aesKey(secret.key), new TextEncoder().encode(JSON.stringify(body)));
  return { iv: bytesToB64url(iv), ct: bytesToB64url(ct) };
}

export async function decryptBody(secret: RoomSecret, roomId: string, enc: EncryptedBody): Promise<PlainBody> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(enc.iv), additionalData: new TextEncoder().encode(roomId) }, await aesKey(secret.key), b64urlToBytes(enc.ct));
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as PlainBody;
  return { text: typeof parsed.text === 'string' ? parsed.text.slice(0, 4000) : '', ...(parsed.image ? { image: parsed.image } : {}) };
}

/* ------------------------------------------------------------------ private rooms (invite links) */

/** A random 256-bit secret carried in the invite link's #fragment, which browsers never send to the server. */
export function newInviteSecret(): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hkdf(secret: Uint8Array<ArrayBuffer>, salt: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(salt), info: new TextEncoder().encode(info) }, material, 256));
}

/**
 * Same split as password rooms (independent join proof + AES key), but the input is already a full-entropy random
 * secret, so HKDF is used instead of a slow password KDF.
 */
export async function deriveInviteSecret(invite: string, salt: string): Promise<RoomSecret & { invite: string }> {
  const raw = b64urlToBytes(invite);
  if (raw.length < 16) throw new Error('Invalid invite');
  const [proof, key] = await Promise.all([hkdf(raw, salt, 'pulse-room-auth'), hkdf(raw, salt, 'pulse-room-key')]);
  return { proof: bytesToB64url(proof), key: bytesToB64url(key), invite };
}

/** Invite link format: <origin>/#join=<roomId>.<salt>.<secret> — everything after # stays in the browser. */
export function inviteLink(roomId: string, salt: string, invite: string, origin: string = location.origin): string {
  return `${origin}/#join=${roomId}.${salt}.${invite}`;
}

export function parseInvite(hash: string): { roomId: string; salt: string; invite: string } | null {
  const match = /^#join=([a-z0-9-]{3,48})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{22,64})$/.exec(hash);
  return match ? { roomId: match[1], salt: match[2], invite: match[3] } : null;
}
