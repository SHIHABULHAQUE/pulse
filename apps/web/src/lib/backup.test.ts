import { describe, expect, it } from 'vitest';
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportFile } from '@pulse/protocol';
import { decryptExport, encryptExport, exportFilename, isEncrypted, parseImport } from './backup';
import { b64urlToBytes, bytesToB64url } from './b64';

async function sampleExport(): Promise<ExportFile> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), app: 'pulse',
    identity: { algorithm: 'ECDSA-P256', publicKeySpki: bytesToB64url(await crypto.subtle.exportKey('spki', pair.publicKey)), publicKeyJwk: pub as never, privateKeyJwk: priv as never },
    profile: { handle: 'ana', bio: '', status: 'online' },
    settings: { readReceipts: true, typingIndicators: true, sounds: true, theme: 'system', language: 'en' },
    contacts: [], rooms: [{ id: 'lobby', name: 'Lobby', owned: false, joinedAt: 1 }],
    messages: [{ id: 'm', clientMessageId: 'c', roomId: 'lobby', text: 'hello ✓ বাংলা', author: { publicKey: 'k'.repeat(44), handle: 'ana' }, sentAt: 1 }]
  };
}

describe('base64url', () => {
  it('round trips arbitrary bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1000));
    expect([...b64urlToBytes(bytesToB64url(bytes))]).toEqual([...bytes]);
  });
});

describe('encrypted backups', () => {
  it('round trips with the right passphrase (PBKDF2 → AES-GCM)', async () => {
    const file = await sampleExport();
    const enc = await encryptExport(file, 'correct horse battery', 100_000);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc.ciphertext).not.toContain('hello');
    expect(await decryptExport(enc, 'correct horse battery')).toEqual(file);
    const imported = await parseImport(JSON.stringify(enc), 'correct horse battery');
    expect(imported.messages[0].text).toBe('hello ✓ বাংলা');
  });

  it('rejects a wrong passphrase and tampered ciphertext', async () => {
    const enc = await encryptExport(await sampleExport(), 'correct horse battery', 100_000);
    await expect(decryptExport(enc, 'wrong passphrase!')).rejects.toThrow(/Wrong passphrase/);
    const tampered = { ...enc, ciphertext: enc.ciphertext.slice(0, -4) + (enc.ciphertext.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    await expect(decryptExport(tampered, 'correct horse battery')).rejects.toThrow();
  });

  it('requires a passphrase for encrypted files and refuses short ones', async () => {
    const file = await sampleExport();
    await expect(encryptExport(file, 'short')).rejects.toThrow(/8 characters/);
    const enc = await encryptExport(file, 'long enough pass', 100_000);
    await expect(parseImport(JSON.stringify(enc))).rejects.toThrow(/passphrase/);
  });
});

describe('import validation', () => {
  it('accepts a valid plain export', async () => {
    const file = await sampleExport();
    expect((await parseImport(JSON.stringify(file))).profile.handle).toBe('ana');
  });

  it('gives readable errors for bad files', async () => {
    await expect(parseImport('{nope')).rejects.toThrow(/not valid JSON/);
    await expect(parseImport(JSON.stringify({ format: 'something-else' }))).rejects.toThrow(/Not a Pulse export/);
    const file = await sampleExport();
    await expect(parseImport(JSON.stringify({ ...file, messages: 'x' }))).rejects.toThrow(/schema/);
  });

  it('builds dated, filesystem-safe filenames', () => {
    expect(exportFilename('Ana Maria!', false)).toMatch(/^pulse-ana-maria-\d{4}-\d{2}-\d{2}\.json$/);
    expect(exportFilename('x', true)).toMatch(/\.encrypted\.json$/);
  });
});
