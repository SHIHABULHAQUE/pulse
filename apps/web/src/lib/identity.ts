import { bytesToB64url } from './b64';
import { getKv, setKv, type Profile, type StoredIdentity } from './db';

const LEGACY_KEY = 'pulse.identity.v1';

export function defaultHandle(publicKeyJwk: JsonWebKey): string {
  return `pulse-${(publicKeyJwk.x ?? 'user').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toLowerCase()}`;
}

async function generate(): Promise<StoredIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    publicKeySpki: bytesToB64url(await crypto.subtle.exportKey('spki', pair.publicKey)),
    publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    createdAt: Date.now()
  };
}

/** Loads the device identity from IndexedDB, migrating the Phase 1 localStorage copy or generating a new keypair. */
export async function loadIdentity(): Promise<{ identity: StoredIdentity; profile: Profile }> {
  let identity = await getKv('identity');
  let profile = await getKv('profile');
  if (!identity) {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as { handle: string; privateKey: JsonWebKey; publicKey: JsonWebKey; publicKeySpki: string };
      identity = { publicKeySpki: old.publicKeySpki, publicKeyJwk: old.publicKey, privateKeyJwk: old.privateKey, createdAt: Date.now() };
      profile ??= { handle: old.handle, bio: '', status: 'online' };
    } else {
      identity = await generate();
    }
    await setKv('identity', identity);
    localStorage.removeItem(LEGACY_KEY);
  }
  if (!profile) { profile = { handle: defaultHandle(identity.publicKeyJwk), bio: '', status: 'online' }; }
  await setKv('profile', profile);
  return { identity, profile };
}

export async function signChallenge(identity: StoredIdentity, challenge: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', identity.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return bytesToB64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(challenge)));
}

/** Short, human-checkable fingerprint of a public key (for "is this really them?" comparisons). */
export async function fingerprint(publicKeySpki: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKeySpki)));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
}
