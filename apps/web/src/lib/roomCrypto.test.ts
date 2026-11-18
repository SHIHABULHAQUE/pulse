import { describe, expect, it } from 'vitest';
import { decryptBody, deriveRoomSecret, encryptBody, newSalt } from './roomCrypto';

const IT = 1000; // fast iterations for tests; production uses ROOM_KDF_ITERATIONS

describe('locked room crypto', () => {
  it('derives the same secret from the same password and salt, different for other salts', async () => {
    const salt = newSalt();
    const a = await deriveRoomSecret('kerala123', salt, IT);
    const b = await deriveRoomSecret('kerala123', salt, IT);
    const c = await deriveRoomSecret('kerala123', newSalt(), IT);
    expect(a).toEqual(b);
    expect(a.proof).not.toBe(c.proof);
  });

  it('keeps the server-side proof independent from the encryption key', async () => {
    const s = await deriveRoomSecret('kerala123', newSalt(), IT);
    expect(s.proof).not.toBe(s.key);
    expect(s.proof).toHaveLength(43);
    expect(s.key).toHaveLength(43);
  });

  it('round trips text and images; ciphertext does not contain the plaintext', async () => {
    const s = await deriveRoomSecret('kerala123', newSalt(), IT);
    const body = { text: 'secret plan ☕ ബാക്കി', image: { mime: 'image/webp' as const, data: 'UklGRiQAAABXRUJQ', width: 2, height: 2 } };
    const enc = await encryptBody(s, 'room-1', body);
    expect(enc.ct).not.toContain('secret');
    expect(await decryptBody(s, 'room-1', enc)).toEqual(body);
  });

  it('fails with the wrong password', async () => {
    const salt = newSalt();
    const right = await deriveRoomSecret('kerala123', salt, IT);
    const wrong = await deriveRoomSecret('kerala124', salt, IT);
    const enc = await encryptBody(right, 'room-1', { text: 'hi' });
    await expect(decryptBody(wrong, 'room-1', enc)).rejects.toThrow();
  });

  it('binds ciphertext to its room so it cannot be replayed into another room', async () => {
    const s = await deriveRoomSecret('kerala123', newSalt(), IT);
    const enc = await encryptBody(s, 'room-1', { text: 'hi' });
    await expect(decryptBody(s, 'room-2', enc)).rejects.toThrow();
  });

  it('uses a fresh IV for every message', async () => {
    const s = await deriveRoomSecret('kerala123', newSalt(), IT);
    const a = await encryptBody(s, 'r', { text: 'same' });
    const b = await encryptBody(s, 'r', { text: 'same' });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});
