import { describe, expect, it } from 'vitest';
import { ClientMessageSchema, EXPORT_FORMAT, EXPORT_VERSION, RoomSettingsSchema, decodeClient, decodeServer, encode, migrateExport } from './index';

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

  it('rejects oversized and empty chat text', () => {
    const base = { type: 'chat.send', requestId: 'x', payload: { roomId: 'lobby', clientMessageId: 'm', text: '' } };
    expect(() => ClientMessageSchema.parse(base)).toThrow();
    expect(() => ClientMessageSchema.parse({ ...base, payload: { ...base.payload, text: 'x'.repeat(4001) } })).toThrow();
  });

  it('rejects invalid handles and room ids', () => {
    expect(() => ClientMessageSchema.parse({ type: 'profile.update', requestId: 'r', payload: { handle: '<script>' } })).toThrow();
    expect(() => ClientMessageSchema.parse({ type: 'room.join', requestId: 'r', payload: { roomId: '../etc' } })).toThrow();
  });

  it('applies room setting defaults and bounds', () => {
    expect(RoomSettingsSchema.parse({ name: 'Cafe' })).toMatchObject({ mode: 'text', memberCap: 100, slowModeSec: 0 });
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
