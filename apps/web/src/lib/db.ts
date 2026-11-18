import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Author, ImageAttachment, Status } from '@pulse/protocol';

export type DeliveryState = 'pending' | 'sent' | 'failed';
/** A message as stored on this device: always decrypted. */
export type LocalMessage = {
  id: string;
  clientMessageId: string;
  roomId: string;
  text: string;
  image?: ImageAttachment;
  /** Sent end-to-end encrypted (locked room). */
  encrypted?: boolean;
  author: Author;
  sentAt: number;
  state: DeliveryState;
  error?: string;
};

export type StoredIdentity = { publicKeySpki: string; publicKeyJwk: JsonWebKey; privateKeyJwk: JsonWebKey; createdAt: number };
export type Profile = { handle: string; bio: string; status: Status };
export type Settings = { readReceipts: boolean; typingIndicators: boolean; sounds: boolean; theme: 'system' | 'dark' | 'light'; language: string };
/** secret: password-derived join proof and AES key for locked rooms (see roomCrypto.ts). */
export type JoinedRoom = { id: string; name: string; owned: boolean; joinedAt: number; secret?: { proof: string; key: string } };
export type Contact = { publicKey: string; handle: string; addedAt: number; blocked: boolean };

export const DEFAULT_SETTINGS: Settings = { readReceipts: true, typingIndicators: true, sounds: true, theme: 'system', language: 'en' };

type KvShape = { identity: StoredIdentity; profile: Profile; settings: Settings; rooms: JoinedRoom[]; contacts: Contact[] };

interface PulseDB extends DBSchema {
  kv: { key: keyof KvShape; value: KvShape[keyof KvShape] };
  messages: { key: string; value: LocalMessage; indexes: { byRoom: [string, number] } };
  outbox: { key: string; value: { clientMessageId: string; roomId: string; text: string; image?: ImageAttachment; queuedAt: number } };
}

export const DB_NAME = 'pulse';
let dbPromise: Promise<IDBPDatabase<PulseDB>> | null = null;

export function db(): Promise<IDBPDatabase<PulseDB>> {
  dbPromise ??= openDB<PulseDB>(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore('kv');
      // Keyed by clientMessageId so the optimistic copy and the server echo collapse into one record.
      const messages = database.createObjectStore('messages', { keyPath: 'clientMessageId' });
      messages.createIndex('byRoom', ['roomId', 'sentAt']);
      database.createObjectStore('outbox', { keyPath: 'clientMessageId' });
    }
  });
  return dbPromise;
}

export async function getKv<K extends keyof KvShape>(key: K): Promise<KvShape[K] | undefined> {
  return (await (await db()).get('kv', key)) as KvShape[K] | undefined;
}
export async function setKv<K extends keyof KvShape>(key: K, value: KvShape[K]): Promise<void> {
  await (await db()).put('kv', value, key);
}

export const HISTORY_LIMIT = 200;

export async function putMessage(message: LocalMessage): Promise<void> {
  await (await db()).put('messages', message);
}

/** Most recent `limit` messages for a room, oldest first. */
export async function roomMessages(roomId: string, limit = HISTORY_LIMIT): Promise<LocalMessage[]> {
  const database = await db();
  const range = IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);
  const out: LocalMessage[] = [];
  let cursor = await database.transaction('messages').store.index('byRoom').openCursor(range, 'prev');
  while (cursor && out.length < limit) { out.push(cursor.value); cursor = await cursor.continue(); }
  return out.reverse();
}

export async function allMessages(): Promise<LocalMessage[]> {
  return (await db()).getAll('messages');
}

/** Local full-text search across every stored message (case-insensitive, all terms must match). */
export async function searchMessages(query: string, limit = 100): Promise<LocalMessage[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: LocalMessage[] = [];
  let cursor = await (await db()).transaction('messages').store.openCursor();
  while (cursor) {
    const text = `${cursor.value.text} ${cursor.value.author.handle}`.toLowerCase();
    if (terms.every((t) => text.includes(t))) hits.push(cursor.value);
    cursor = await cursor.continue();
  }
  return hits.sort((a, b) => b.sentAt - a.sentAt).slice(0, limit);
}

export async function queueOutbox(item: PulseDB['outbox']['value']): Promise<void> { await (await db()).put('outbox', item); }
export async function outboxItems(): Promise<PulseDB['outbox']['value'][]> { return (await (await db()).getAll('outbox')).sort((a, b) => a.queuedAt - b.queuedAt); }
export async function removeOutbox(clientMessageId: string): Promise<void> { await (await db()).delete('outbox', clientMessageId); }

export async function wipeDevice(): Promise<void> {
  if (dbPromise) { (await dbPromise).close(); dbPromise = null; }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
  localStorage.clear();
  sessionStorage.clear();
  if ('caches' in window) for (const key of await caches.keys()) await caches.delete(key);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
