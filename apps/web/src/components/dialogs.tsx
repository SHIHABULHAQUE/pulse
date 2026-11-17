import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { HandleSchema, RoomSettingsSchema, type RoomSettings } from '@pulse/protocol';
import { Modal } from './Modal';
import { toast, usePulse } from '../store';
import { createRoom, joinRoom, refreshDirectory, updateProfile } from '../lib/client';
import { applyImport, buildExport, downloadJson, encryptExport, exportFilename, isEncrypted, parseImport } from '../lib/backup';
import { searchMessages, storageEstimate, wipeDevice, type LocalMessage } from '../lib/db';
import { fingerprint } from '../lib/identity';
import { formatBytes, formatDay, formatTime } from './util';

const close = () => usePulse.getState().set({ dialog: null });

/* ------------------------------------------------------------------ create room */

export function CreateRoomDialog() {
  const [form, setForm] = useState<RoomSettings>({ name: '', topic: '', emoji: '💬', mode: 'text', memberCap: 100, slowModeSec: 0, rules: '' });
  const [error, setError] = useState('');
  const update = <K extends keyof RoomSettings>(key: K, value: RoomSettings[K]) => setForm((f) => ({ ...f, [key]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = RoomSettingsSchema.safeParse(form);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    if (!createRoom(parsed.data)) { setError('You are offline'); return; }
    close();
  }

  return (
    <Modal title="Create a room" onClose={close}>
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          <label className="field narrow"><span>Icon</span><input value={form.emoji} maxLength={4} onChange={(e) => update('emoji', e.target.value)} aria-label="Room icon (emoji)" /></label>
          <label className="field"><span>Name</span><input required autoFocus value={form.name} maxLength={80} onChange={(e) => update('name', e.target.value)} placeholder="Kochi night owls" /></label>
        </div>
        <label className="field"><span>Topic</span><input value={form.topic} maxLength={200} onChange={(e) => update('topic', e.target.value)} placeholder="What's this room about?" /></label>
        <div className="form-row">
          <label className="field"><span>Type</span>
            <select value={form.mode} onChange={(e) => update('mode', e.target.value as RoomSettings['mode'])}>
              <option value="text">Text</option><option value="voice">Voice</option><option value="both">Text + voice</option>
            </select>
          </label>
          <label className="field"><span>Member cap</span><input type="number" min={2} max={500} value={form.memberCap} onChange={(e) => update('memberCap', Number(e.target.value))} /></label>
          <label className="field"><span>Slow mode</span>
            <select value={form.slowModeSec} onChange={(e) => update('slowModeSec', Number(e.target.value))}>
              {[0, 5, 10, 30, 60, 300].map((s) => <option key={s} value={s}>{s === 0 ? 'Off' : s < 60 ? `${s}s` : `${s / 60} min`}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>Rules</span><textarea rows={3} value={form.rules} maxLength={2000} onChange={(e) => update('rules', e.target.value)} placeholder="Be kind. Stay on topic." /></label>
        <p className="hint">Public room, visible in the directory. Empty rooms expire after a while unless you pin them. Private rooms arrive with end-to-end encryption in a later phase.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="row-actions end"><button type="button" className="ghost-button" onClick={close}>Cancel</button><button className="primary" type="submit">Create room</button></div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ directory */

export function DirectoryDialog() {
  const { directory, joined } = usePulse();
  const [query, setQuery] = useState('');
  useEffect(() => { refreshDirectory(); }, []);
  const joinedIds = new Set(joined.map((r) => r.id));
  const rooms = useMemo(() => {
    const q = query.trim().toLowerCase();
    return directory
      .filter((r) => r.kind === 'public' && (!q || `${r.name} ${r.topic}`.toLowerCase().includes(q)))
      .sort((a, b) => b.members - a.members || Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
  }, [directory, query]);

  return (
    <Modal title="Browse rooms" onClose={close} wide>
      <div className="directory">
        <input type="search" className="search-input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search rooms by name or topic" aria-label="Search rooms" />
        <p className="hint">Sorted by people active right now.</p>
        <ul className="directory-list">
          {rooms.map((r, i) => (
            <li key={r.id} className="directory-item">
              <span className="room-emoji" aria-hidden="true">{r.emoji}</span>
              <div className="grow">
                <strong>{r.name}</strong>{i < 3 && r.members > 0 && <span className="badge hot">trending</span>}{r.pinned && <span className="badge">pinned</span>}
                <small>{r.topic || 'No topic'}</small>
                <small className="muted">{r.members}/{r.memberCap} online · {r.mode === 'text' ? 'text' : r.mode === 'voice' ? 'voice' : 'text + voice'}{r.slowModeSec ? ` · slow mode ${r.slowModeSec}s` : ''}</small>
              </div>
              <button className={joinedIds.has(r.id) ? 'ghost-button small' : 'primary small'} onClick={() => joinRoom(r.id)} disabled={!joinedIds.has(r.id) && r.members >= r.memberCap}>
                {joinedIds.has(r.id) ? 'Open' : r.members >= r.memberCap ? 'Full' : 'Join'}
              </button>
            </li>
          ))}
          {rooms.length === 0 && <li className="muted">No rooms match. <button className="link" onClick={() => usePulse.getState().set({ dialog: 'create' })}>Create one</button></li>}
        </ul>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ search */

export function SearchDialog() {
  const { directory } = usePulse();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<LocalMessage[]>([]);
  useEffect(() => {
    const t = setTimeout(() => { void searchMessages(query).then(setHits); }, 150);
    return () => clearTimeout(t);
  }, [query]);
  return (
    <Modal title="Search messages" onClose={close} wide>
      <input type="search" className="search-input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search everything stored on this device" aria-label="Search messages" />
      <p className="hint">Search runs locally over your device's history. Nothing is sent to the server.</p>
      <ul className="search-results" aria-live="polite">
        {hits.map((m) => (
          <li key={m.clientMessageId}>
            <button className="search-hit" onClick={() => { usePulse.getState().set({ activeRoom: m.roomId, dialog: null }); }}>
              <small>{directory.find((r) => r.id === m.roomId)?.name ?? m.roomId} · {m.author.handle} · {formatDay(m.sentAt)} {formatTime(m.sentAt)}</small>
              <span>{m.text}</span>
            </button>
          </li>
        ))}
        {query && hits.length === 0 && <li className="muted">No matches.</li>}
      </ul>
    </Modal>
  );
}

/* ------------------------------------------------------------------ settings & data */

export function SettingsDialog() {
  const { profile, identity } = usePulse();
  const [handle, setHandle] = useState(profile?.handle ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [fp, setFp] = useState('');
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [importPass, setImportPass] = useState('');
  const [pendingImport, setPendingImport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (identity) void fingerprint(identity.publicKeySpki).then(setFp); void storageEstimate().then(setUsage); }, [identity]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    const parsed = HandleSchema.safeParse(handle);
    if (!parsed.success) { toast(parsed.error.issues[0]?.message ?? 'Invalid handle', 'error'); return; }
    await updateProfile({ handle: parsed.data, bio: bio.slice(0, 280) });
    toast('Profile saved');
  }

  async function doExport(encrypted: boolean) {
    setBusy(true);
    try {
      const file = await buildExport();
      const data = encrypted ? await encryptExport(file, passphrase) : file;
      downloadJson(data, exportFilename(file.profile.handle, encrypted));
      toast(encrypted ? 'Encrypted backup downloaded' : 'Export downloaded');
      setPassphrase('');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 250 * 1024 * 1024) { toast('That file is too large', 'error'); return; }
    const text = await file.text();
    let needsPass = false;
    try { needsPass = isEncrypted(JSON.parse(text)); } catch { /* parseImport reports it */ }
    if (needsPass) { setPendingImport(text); return; }
    await doImport(text);
  }

  async function doImport(text: string, pass?: string) {
    setBusy(true);
    try {
      const file = await parseImport(text, pass);
      const replacing = identity && identity.publicKeySpki !== file.identity.publicKeySpki;
      if (replacing && !confirm(`This replaces the identity on this device with "${file.profile.handle}". Export your current identity first if you want to keep it. Continue?`)) return;
      await applyImport(file);
      sessionStorage.clear();
      toast(`Imported ${file.messages.length} messages. Reloading…`);
      setTimeout(() => location.reload(), 800);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function wipe() {
    if (!confirm('Erase your identity, messages and settings from this device? This cannot be undone. Export first if you want to keep them.')) return;
    await wipeDevice();
    location.reload();
  }

  return (
    <Modal title="Settings & data" onClose={close} wide>
      <div className="settings">
        <section aria-labelledby="profile-h">
          <h3 id="profile-h">Profile</h3>
          <form className="form" onSubmit={saveProfile}>
            <label className="field"><span>Handle</span><input value={handle} maxLength={32} onChange={(e) => setHandle(e.target.value)} /></label>
            <label className="field"><span>Bio</span><textarea rows={2} value={bio} maxLength={280} onChange={(e) => setBio(e.target.value)} /></label>
            <div className="row-actions end"><button className="primary" type="submit">Save profile</button></div>
          </form>
          <p className="hint">Your ID is your public key. Fingerprint: <code>{fp || '…'}</code></p>
        </section>

        <section aria-labelledby="data-h">
          <h3 id="data-h">Your data</h3>
          <p className="hint">Everything (your keys, profile, rooms and messages) lives on this device. Export it to keep a copy or move to another device.</p>
          {usage && (
            <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={usage.quota} aria-valuenow={usage.usage} aria-label="Storage used">
              <div className="meter-bar"><i style={{ width: `${Math.min(100, (usage.usage / Math.max(1, usage.quota)) * 100)}%` }} /></div>
              <small>{formatBytes(usage.usage)} used of {formatBytes(usage.quota)} available</small>
            </div>
          )}
          <div className="data-actions">
            <button className="ghost-button" disabled={busy} onClick={() => void doExport(false)}>Export my data (JSON)</button>
            <div className="inline-form">
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Passphrase (8+ chars)" aria-label="Backup passphrase" autoComplete="new-password" />
              <button className="ghost-button" disabled={busy || passphrase.length < 8} onClick={() => void doExport(true)}>Encrypted backup</button>
            </div>
            <label className="ghost-button file-button">
              Import from file
              <input ref={fileInput} type="file" accept="application/json,.json" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
            {pendingImport && (
              <div className="inline-form">
                <input type="password" autoFocus value={importPass} onChange={(e) => setImportPass(e.target.value)} placeholder="Backup passphrase" aria-label="Passphrase for the encrypted backup" />
                <button className="primary" disabled={busy || !importPass} onClick={() => void doImport(pendingImport, importPass)}>Decrypt &amp; import</button>
              </div>
            )}
            <p className="warn">⚠ A plain export contains your private key. Anyone with the file can act as you; prefer the encrypted backup.</p>
          </div>
        </section>

        <section aria-labelledby="danger-h">
          <h3 id="danger-h">Danger zone</h3>
          <button className="danger" onClick={() => void wipe()}>Wipe this device</button>
        </section>
      </div>
    </Modal>
  );
}
