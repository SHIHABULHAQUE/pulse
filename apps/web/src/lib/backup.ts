import {
  EXPORT_ENCRYPTED_FORMAT, EXPORT_FORMAT, EXPORT_VERSION, EncryptedExportSchema, migrateExport,
  type EncryptedExport, type ExportFile
} from '@pulse/protocol';
import { b64urlToBytes, bytesToB64url } from './b64';
import { DEFAULT_SETTINGS, allMessages, getKv, putMessage, setKv } from './db';

export const PBKDF2_ITERATIONS = 600_000;

export async function buildExport(): Promise<ExportFile> {
  const identity = await getKv('identity');
  const profile = await getKv('profile');
  if (!identity || !profile) throw new Error('No identity on this device yet');
  const messages = (await allMessages()).filter((m) => m.state === 'sent').map(({ state: _s, error: _e, ...m }) => m);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'pulse',
    identity: { algorithm: 'ECDSA-P256', publicKeySpki: identity.publicKeySpki, publicKeyJwk: identity.publicKeyJwk as ExportFile['identity']['publicKeyJwk'], privateKeyJwk: identity.privateKeyJwk as ExportFile['identity']['privateKeyJwk'] },
    profile,
    settings: (await getKv('settings')) ?? DEFAULT_SETTINGS,
    contacts: (await getKv('contacts')) ?? [],
    rooms: (await getKv('rooms')) ?? [],
    messages
  };
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptExport(file: ExportFile, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<EncryptedExport> {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters');
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const key = await deriveKey(passphrase, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(file)));
  return { format: EXPORT_ENCRYPTED_FORMAT, version: EXPORT_VERSION, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToB64url(salt) }, cipher: { name: 'AES-GCM', iv: bytesToB64url(iv) }, ciphertext: bytesToB64url(ciphertext) };
}

export async function decryptExport(file: EncryptedExport, passphrase: string): Promise<unknown> {
  const key = await deriveKey(passphrase, b64urlToBytes(file.kdf.salt), file.kdf.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(file.cipher.iv) }, key, b64urlToBytes(file.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new Error('Wrong passphrase or damaged file'); }
}

export function isEncrypted(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { format?: unknown }).format === EXPORT_ENCRYPTED_FORMAT;
}

/** Parse, decrypt if needed, migrate and validate. Throws a readable error on any problem. */
export async function parseImport(text: string, passphrase?: string): Promise<ExportFile> {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON'); }
  if (isEncrypted(data)) {
    const parsed = EncryptedExportSchema.safeParse(data);
    if (!parsed.success) throw new Error('Encrypted backup is malformed');
    if (!passphrase) throw new Error('This backup is encrypted: enter its passphrase');
    data = await decryptExport(parsed.data, passphrase);
  }
  try { return migrateExport(data); } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.startsWith('[') ? 'The file does not match the Pulse export schema' : msg);
  }
}

/** Replaces this device's identity and profile with the imported ones and merges history. */
export async function applyImport(file: ExportFile): Promise<void> {
  // Prove the private key is usable before replacing anything.
  await crypto.subtle.importKey('jwk', file.identity.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  await setKv('identity', { publicKeySpki: file.identity.publicKeySpki, publicKeyJwk: file.identity.publicKeyJwk, privateKeyJwk: file.identity.privateKeyJwk, createdAt: Date.now() });
  await setKv('profile', file.profile);
  await setKv('settings', { ...DEFAULT_SETTINGS, ...file.settings });
  await setKv('contacts', file.contacts);
  await setKv('rooms', file.rooms);
  for (const m of file.messages) await putMessage({ ...m, state: 'sent' });
}

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportFilename(handle: string, encrypted: boolean): string {
  const safe = handle.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'user';
  return `pulse-${safe}-${new Date().toISOString().slice(0, 10)}${encrypted ? '.encrypted' : ''}.json`;
}
