import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RoomSchema, RoomSettingsSchema, type Room, type RoomSettings } from '@pulse/protocol';

/** scrypt(proof). The proof is itself PBKDF2(password), so neither the password nor the room key ever reach the server. */
const PasswordHashSchema = z.object({ salt: z.string().max(64), hash: z.string().max(128) });
type PasswordHash = z.infer<typeof PasswordHashSchema>;

/** Room definition without live membership. Only this (for pinned public rooms) is ever written to disk. */
type RoomDef = Omit<Room, 'members'> & { lastActiveAt: number; passwordHash: PasswordHash | null };

const SnapshotSchema = z.object({
  version: z.literal(1),
  rooms: z.array(RoomSchema.omit({ members: true }).extend({ passwordHash: PasswordHashSchema.nullable().default(null) }))
});

function hashProof(proof: string, salt = randomBytes(16).toString('base64url')): PasswordHash {
  return { salt, hash: scryptSync(proof, salt, 32).toString('base64url') };
}

export const LOBBY_ID = 'lobby';

export function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  return `${base.length >= 2 ? base : 'room'}-${randomBytes(3).toString('hex')}`;
}

export class RoomRegistry {
  private readonly defs = new Map<string, RoomDef>();
  /** roomId → set of session ids currently in it. */
  private readonly members = new Map<string, Set<string>>();
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: { dataDir: string | null; idleMs: number; debounceMs: number; now?: () => number; onError?: (err: unknown) => void }) {
    const now = this.now();
    this.defs.set(LOBBY_ID, { id: LOBBY_ID, name: 'Lobby', topic: 'A public room for everyone', emoji: '👋', mode: 'both', memberCap: 500, slowModeSec: 0, rules: 'Be kind. No spam. No personal info.', kind: 'public', ownerKey: null, pinned: true, locked: false, keySalt: null, passwordHash: null, createdAt: now, lastActiveAt: now });
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  view(id: string): Room | null {
    const def = this.defs.get(id);
    if (!def) return null;
    const { lastActiveAt: _l, passwordHash: _p, ...room } = def;
    return { ...room, members: this.members.get(id)?.size ?? 0 };
  }

  /** Public rooms for the directory, busiest first (trending). */
  list(): Room[] {
    return [...this.defs.keys()].map((id) => this.view(id)!).filter((r) => r.kind === 'public').sort((a, b) => b.members - a.members || b.createdAt - a.createdAt);
  }

  get size(): number { return this.defs.size; }

  create(settings: RoomSettings, ownerKey: string, lock?: { salt: string; proof: string }): Room {
    const parsed = RoomSettingsSchema.parse(settings);
    let id = slugify(parsed.name);
    while (this.defs.has(id)) id = slugify(parsed.name);
    const now = this.now();
    this.defs.set(id, { ...parsed, id, kind: 'public', ownerKey, pinned: false, locked: !!lock, keySalt: lock?.salt ?? null, passwordHash: lock ? hashProof(lock.proof) : null, createdAt: now, lastActiveAt: now });
    return this.view(id)!;
  }

  /** True for open rooms; for locked rooms, a constant-time check of scrypt(proof). */
  checkProof(id: string, proof: string | undefined): boolean {
    const def = this.defs.get(id);
    if (!def) return false;
    if (!def.passwordHash) return true;
    if (!proof) return false;
    const expected = Buffer.from(def.passwordHash.hash, 'base64url');
    const actual = Buffer.from(hashProof(proof, def.passwordHash.salt).hash, 'base64url');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  memberCount(id: string): number { return this.members.get(id)?.size ?? 0; }

  isMember(id: string, sessionId: string): boolean { return this.members.get(id)?.has(sessionId) ?? false; }

  addMember(id: string, sessionId: string): void {
    let set = this.members.get(id);
    if (!set) { set = new Set(); this.members.set(id, set); }
    set.add(sessionId);
    this.touch(id);
  }

  removeMember(id: string, sessionId: string): void {
    const set = this.members.get(id);
    if (!set) return;
    set.delete(sessionId);
    if (set.size === 0) this.members.delete(id);
    this.touch(id);
  }

  touch(id: string): void { const def = this.defs.get(id); if (def) def.lastActiveAt = this.now(); }

  setPinned(id: string, pinned: boolean): Room | null {
    const def = this.defs.get(id);
    if (!def || id === LOBBY_ID) return null;
    def.pinned = pinned;
    this.scheduleSnapshot();
    return this.view(id);
  }

  ownerOf(id: string): string | null { return this.defs.get(id)?.ownerKey ?? null; }

  /** Remove empty, unpinned rooms idle longer than idleMs. Returns removed ids. */
  sweep(): string[] {
    const removed: string[] = [];
    const cutoff = this.now() - this.opts.idleMs;
    for (const [id, def] of this.defs) {
      if (def.pinned || id === LOBBY_ID || this.memberCount(id) > 0 || def.lastActiveAt > cutoff) continue;
      this.defs.delete(id);
      removed.push(id);
    }
    return removed;
  }

  /* ---------------------------------------------------------------- persistence */

  private get file(): string | null { return this.opts.dataDir ? join(this.opts.dataDir, 'rooms.json') : null; }

  async load(): Promise<number> {
    const file = this.file;
    if (!file || !existsSync(file)) return 0;
    const parsed = SnapshotSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!parsed.success) { this.opts.onError?.(parsed.error); return 0; }
    const now = this.now();
    let count = 0;
    for (const room of parsed.data.rooms) {
      if (room.id === LOBBY_ID || room.kind !== 'public' || !room.pinned) continue;
      this.defs.set(room.id, { ...room, lastActiveAt: now });
      count += 1;
    }
    return count;
  }

  scheduleSnapshot(): void {
    if (!this.file || this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.saveNow().catch((err) => this.opts.onError?.(err));
    }, this.opts.debounceMs);
    this.snapshotTimer.unref();
  }

  /** Atomic write: temp file then rename. Only pinned public room definitions. */
  async saveNow(): Promise<void> {
    const file = this.file;
    if (!file) return;
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
    await mkdir(this.opts.dataDir!, { recursive: true });
    // Locked rooms keep only scrypt(proof): enough to check joins, useless for reading messages.
    const rooms = [...this.defs.values()].filter((d) => d.pinned && d.kind === 'public' && d.id !== LOBBY_ID).map(({ lastActiveAt: _l, ...def }) => def);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, rooms }, null, 2), 'utf8');
    await rename(tmp, file);
  }
}
