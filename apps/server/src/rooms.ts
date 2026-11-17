import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { RoomSchema, RoomSettingsSchema, type Room, type RoomSettings } from '@pulse/protocol';

/** Room definition without live membership. Only this (for pinned public rooms) is ever written to disk. */
type RoomDef = Omit<Room, 'members'> & { lastActiveAt: number };

const SnapshotSchema = z.object({
  version: z.literal(1),
  rooms: z.array(RoomSchema.omit({ members: true }))
});

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
    this.defs.set(LOBBY_ID, { id: LOBBY_ID, name: 'Lobby', topic: 'A public room for everyone', emoji: '👋', mode: 'both', memberCap: 500, slowModeSec: 0, rules: 'Be kind. No spam. No personal info.', kind: 'public', ownerKey: null, pinned: true, createdAt: now, lastActiveAt: now });
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  view(id: string): Room | null {
    const def = this.defs.get(id);
    if (!def) return null;
    const { lastActiveAt: _l, ...room } = def;
    return { ...room, members: this.members.get(id)?.size ?? 0 };
  }

  /** Public rooms for the directory, busiest first (trending). */
  list(): Room[] {
    return [...this.defs.keys()].map((id) => this.view(id)!).filter((r) => r.kind === 'public').sort((a, b) => b.members - a.members || b.createdAt - a.createdAt);
  }

  get size(): number { return this.defs.size; }

  create(settings: RoomSettings, ownerKey: string): Room {
    const parsed = RoomSettingsSchema.parse(settings);
    let id = slugify(parsed.name);
    while (this.defs.has(id)) id = slugify(parsed.name);
    const now = this.now();
    this.defs.set(id, { ...parsed, id, kind: 'public', ownerKey, pinned: false, createdAt: now, lastActiveAt: now });
    return this.view(id)!;
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
    const rooms = [...this.defs.values()].filter((d) => d.pinned && d.kind === 'public' && d.id !== LOBBY_ID).map(({ lastActiveAt: _l, ...def }) => def);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, rooms }, null, 2), 'utf8');
    await rename(tmp, file);
  }
}
