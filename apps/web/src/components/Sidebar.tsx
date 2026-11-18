import type { Status } from '@pulse/protocol';
import { usePulse } from '../store';
import { updateProfile } from '../lib/client';
import { initials } from './util';

const STATUS_LABEL: Record<Status, string> = { online: 'Online', away: 'Away', dnd: 'Do not disturb', invisible: 'Invisible' };

export function Sidebar() {
  const { profile, joined, directory, activeRoom, voice, voiceRooms, set } = usePulse();
  return (
    <aside className="sidebar panel" aria-label="Rooms and profile">
      <div className="profile">
        <div className="avatar" aria-hidden="true">{initials(profile?.handle)}</div>
        <div className="profile-text">
          <strong>{profile?.handle ?? 'Creating identity…'}</strong>
          <label className="status-select">
            <span className="sr-only">Your status</span>
            <i className={`dot ${profile?.status ?? 'online'}`} aria-hidden="true" />
            <select value={profile?.status ?? 'online'} onChange={(e) => void updateProfile({ status: e.target.value as Status })}>
              {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
        </div>
        <button className="icon-button" aria-label="Settings and data" onClick={() => set({ dialog: 'settings' })}>⚙</button>
      </div>

      <div className="section-label">
        <span id="rooms-label">YOUR ROOMS</span>
        <span className="section-actions">
          <button aria-label="Search messages" title="Search messages" onClick={() => set({ dialog: 'search' })}>⌕</button>
          <button aria-label="Browse rooms" title="Browse rooms" onClick={() => set({ dialog: 'directory' })}>☰</button>
          <button aria-label="Create a room" title="Create a room" onClick={() => set({ dialog: 'create' })}>＋</button>
        </span>
      </div>
      <nav className="room-list" aria-labelledby="rooms-label">
        {joined.length === 0 && <p className="muted">Join or create a room to start.</p>}
        {joined.map((entry) => {
          const room = directory.find((r) => r.id === entry.id);
          return (
            <button key={entry.id} className={`room-item ${entry.id === activeRoom ? 'selected' : ''}`} aria-current={entry.id === activeRoom ? 'page' : undefined} onClick={() => set({ activeRoom: entry.id })}>
              <span className="room-icon" aria-hidden="true">{room?.emoji ?? '#'}</span>
              <span className="grow"><strong>{room?.locked ? '🔒 ' : ''}{room?.name ?? entry.name}</strong><small>{room ? `${room.members} online` : 'offline'}{room?.pinned ? ' · pinned' : ''}</small></span>
              {(voiceRooms[entry.id]?.length ?? 0) > 0 && <span className={`voice-count ${voice?.roomId === entry.id ? 'me' : ''}`} title="People in voice">🔊 {voiceRooms[entry.id].length}</span>}
            </button>
          );
        })}
      </nav>
      <button className="ghost-button full" onClick={() => set({ dialog: 'directory' })}>Browse all rooms</button>

      <div className="privacy-note">
        <span aria-hidden="true">✦</span>
        <div><strong>Your data stays with you</strong><p>Messages and keys live on this device. The server only relays live traffic.</p></div>
      </div>
    </aside>
  );
}
