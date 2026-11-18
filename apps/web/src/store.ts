import { create } from 'zustand';
import type { Presence, Room, VoiceParticipant } from '@pulse/protocol';
import { DEFAULT_SETTINGS, type JoinedRoom, type LocalMessage, type Profile, type Settings, type StoredIdentity } from './lib/db';

export type ConnState = 'connecting' | 'online' | 'offline';
export type Toast = { id: number; kind: 'error' | 'info'; text: string };
export type DialogName = 'create' | 'directory' | 'settings' | 'search' | null;

type State = {
  conn: ConnState;
  identity: StoredIdentity | null;
  profile: Profile | null;
  settings: Settings;
  directory: Room[];
  joined: JoinedRoom[];
  activeRoom: string | null;
  presence: Presence[];
  messages: Record<string, LocalMessage[]>;
  toasts: Toast[];
  dialog: DialogName;
  /** The voice channel this device is in. */
  voice: { roomId: string; muted: boolean; connecting: boolean; selfId: string | null } | null;
  /** Who is in each room's voice channel (for rooms we're members of). */
  voiceRooms: Record<string, VoiceParticipant[]>;
  /** sessionId (or "self") → currently speaking. */
  speaking: Record<string, boolean>;
  peerStates: Record<string, RTCPeerConnectionState>;
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void;
};

export const usePulse = create<State>((set) => ({
  conn: 'connecting',
  identity: null,
  profile: null,
  settings: DEFAULT_SETTINGS,
  directory: [],
  joined: [],
  activeRoom: null,
  presence: [],
  messages: {},
  toasts: [],
  dialog: null,
  voice: null,
  voiceRooms: {},
  speaking: {},
  peerStates: {},
  set: (partial) => set(partial)
}));

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId;
  usePulse.getState().set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => usePulse.getState().set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3500);
}

export function upsertRoom(rooms: Room[], room: Room): Room[] {
  const i = rooms.findIndex((r) => r.id === room.id);
  if (i === -1) return [...rooms, room];
  const next = rooms.slice();
  next[i] = room;
  return next;
}
