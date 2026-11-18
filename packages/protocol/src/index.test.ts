import { describe, expect, it } from 'vitest';
import { ClientMessageSchema, EXPORT_FORMAT, EXPORT_VERSION, RoomSettingsSchema, bodyKind, decodeClient, decodeServer, encode, migrateExport } from './index';

const key = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEuXV9LIpywPEYCB4ALQFJ3FffHJeBowoiWThTuGX';

describe('protocol codec', () => {
  it('round trips a valid client message', () => {
    const message = { type: 'room.list' as const, requestId: 'r1' };
    expect(decodeClient(encode(message))).toEqual(message);
  });

  it('round trips a server chat message', () => {
    const message = { type: 'chat.message' as const, requestId: 'r', payload: { id: 'm1', clientMessageId: 'c1', roomId: 'lobby', text: 'hi', author: { publicKey: key, handle: 'ana' }, sentAt: 1 } };
    expect(decodeServer(encode(message))).toEqual(message);
  });

  it('rejects wrong protocol versions', () => {
    expect(() => decodeClient(JSON.stringify({ v: 2, type: 'room.list', requestId: 'r' }))).toThrow(/version/);
  });

  it('rejects unknown message types', () => {
    expect(() => decodeClient(encode({ type: 'admin.shutdown', requestId: 'r' } as never))).toThrow();
  });

  it('rejects oversized chat text and oversized images', () => {
    const base = { type: 'chat.send', requestId: 'x', payload: { roomId: 'lobby', clientMessageId: 'm', text: 'x'.repeat(4001) } };
    expect(() => ClientMessageSchema.parse(base)).toThrow();
    const image = { mime: 'image/webp', data: 'A'.repeat(500_000), width: 10, height: 10 };
    expect(() => ClientMessageSchema.parse({ ...base, payload: { ...base.payload, text: '', image } })).toThrow();
    expect(() => ClientMessageSchema.parse({ ...base, payload: { ...base.payload, text: '', image: { ...image, mime: 'image/svg+xml', data: 'AAAA' } } })).toThrow();
  });

  it('classifies message bodies: plain, encrypted, or invalid', () => {
    const image = { mime: 'image/webp' as const, data: 'AAAA', width: 1, height: 1 };
    const enc = { iv: 'A'.repeat(16), ct: 'AAAA' };
    expect(bodyKind({ text: 'hi' })).toBe('plain');
    expect(bodyKind({ text: '', image })).toBe('plain');
    expect(bodyKind({ text: '', enc })).toBe('encrypted');
    expect(bodyKind({ text: '  ' })).toBeNull();
    expect(bodyKind({ text: 'leak', enc })).toBeNull();
  });

  it('rejects invalid handles and room ids', () => {
    expect(() => ClientMessageSchema.parse({ type: 'profile.update', requestId: 'r', payload: { handle: '<script>' } })).toThrow();
    expect(() => ClientMessageSchema.parse({ type: 'room.join', requestId: 'r', payload: { roomId: '../etc' } })).toThrow();
  });

  it('applies room setting defaults and bounds', () => {
    expect(RoomSettingsSchema.parse({ name: 'Cafe' })).toMatchObject({ mode: 'both', memberCap: 100, slowModeSec: 0 });
    expect(() => RoomSettingsSchema.parse({ name: 'x', memberCap: 10_000 })).toThrow();
  });
});

describe('export migrations', () => {
  const valid = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(0).toISOString(),
    identity: { algorithm: 'ECDSA-P256', publicKeySpki: key, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'c' } },
    profile: { handle: 'ana' },
    settings: {},
    contacts: [],
    rooms: [],
    messages: []
  };

  it('accepts the current version and fills defaults', () => {
    const file = migrateExport(valid);
    expect(file.profile.status).toBe('online');
    expect(file.settings.readReceipts).toBe(true);
  });

  it('rejects files from the future', () => {
    expect(() => migrateExport({ ...valid, version: EXPORT_VERSION + 1 })).toThrow(/Update Pulse/);
  });

  it('rejects files that are not Pulse exports', () => {
    expect(() => migrateExport({ ...valid, format: 'other' })).toThrow();
    expect(() => migrateExport(null)).toThrow();
  });
});
