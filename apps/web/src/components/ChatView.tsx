import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { LIMITS, type ImageAttachment } from '@pulse/protocol';
import { toast, usePulse } from '../store';
import { leaveRoom, pinRoom, retryMessage, sendChat } from '../lib/client';
import { compressImage, imageSrc } from '../lib/image';
import type { LocalMessage } from '../lib/db';
import { VoiceBar } from './VoiceBar';
import { Modal } from './Modal';
import { formatDay, formatTime, hueFor, initials } from './util';

export function ChatView() {
  const { activeRoom, directory, messages, conn, identity, joined, set } = usePulse();
  const room = directory.find((r) => r.id === activeRoom) ?? null;
  const list = (activeRoom && messages[activeRoom]) || [];
  const [draft, setDraft] = useState('');
  const [pendingImage, setPendingImage] = useState<ImageAttachment | null>(null);
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [viewing, setViewing] = useState<ImageAttachment | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const isOwner = !!room && !!identity && room.ownerKey === identity.publicKeySpki;
  const canInvite = room?.kind === 'private' && !!joined.find((r) => r.id === room.id)?.secret?.invite;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list.length, activeRoom]);

  useEffect(() => { setPendingImage(null); setDraft(''); }, [activeRoom]);

  if (!activeRoom) {
    return (
      <section className="chat panel">
        <div className="empty-state">
          <div className="pulse-ring" aria-hidden="true">◉</div>
          <h3>No room selected</h3>
          <p>Browse public rooms or create your own.</p>
          <div className="row-actions">
            <button className="primary" onClick={() => set({ dialog: 'directory' })}>Browse rooms</button>
            <button className="ghost-button" onClick={() => set({ dialog: 'create' })}>Create a room</button>
          </div>
        </div>
      </section>
    );
  }

  async function attach(file: File | Blob | null | undefined) {
    if (!file) return;
    setProcessing(true);
    try { setPendingImage(await compressImage(file)); } catch (err) { toast((err as Error).message, 'error'); } finally {
      setProcessing(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && !pendingImage) || !activeRoom) return;
    void sendChat(activeRoom, text, pendingImage ?? undefined);
    setDraft('');
    setPendingImage(null);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  }

  function onPaste(event: ClipboardEvent) {
    const item = [...event.clipboardData.items].find((i) => i.type.startsWith('image/'));
    if (item) { event.preventDefault(); void attach(item.getAsFile()); }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = [...event.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) void attach(file);
  }

  let lastDay = '';
  return (
    <section className={`chat panel ${dragging ? 'dragging' : ''}`} aria-label={`Chat in ${room?.name ?? activeRoom}`}
      onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}>
      <header className="chat-header">
        <div className="chat-title">
          <span className="room-emoji" aria-hidden="true">{room?.emoji ?? '#'}</span>
          <div>
            <div className="eyebrow">
              {room?.kind === 'private' ? '🔐 PRIVATE · END-TO-END ENCRYPTED' : room?.locked ? '🔒 END-TO-END ENCRYPTED' : 'PUBLIC ROOM'}
              {room && room.slowModeSec > 0 ? ` · SLOW MODE ${room.slowModeSec}s` : ''}
            </div>
            <h2>{room?.name ?? activeRoom}</h2>
            {room?.topic && <p>{room.topic}</p>}
          </div>
        </div>
        <div className="chat-actions">
          <div className="member-count" aria-label={`${room?.members ?? 0} people here`}>{room?.members ?? 0} <span>here</span></div>
          {canInvite && <button className="primary small" onClick={() => set({ dialog: 'invite', inviteRoom: room!.id })}>Invite</button>}
          {room?.rules && <button className="ghost-button small" aria-expanded={showRules} onClick={() => setShowRules((v) => !v)}>Rules</button>}
          {isOwner && room && <button className="ghost-button small" onClick={() => pinRoom(room.id, !room.pinned)}>{room.pinned ? 'Unpin' : 'Pin'}</button>}
          {activeRoom !== 'lobby' && <button className="ghost-button small" onClick={() => leaveRoom(activeRoom)}>Leave</button>}
        </div>
      </header>
      {showRules && room?.rules && <div className="rules" role="note"><strong>Room rules</strong><p>{room.rules}</p></div>}
      {room && room.mode !== 'text' && <VoiceBar roomId={room.id} />}

      <div className="messages" ref={scroller} role="log" aria-live="polite" aria-relevant="additions">
        {list.length === 0 ? (
          <div className="empty-state">
            <div className="pulse-ring" aria-hidden="true">{room?.locked ? '🔒' : '◉'}</div>
            <h3>Welcome to {room?.name ?? 'this room'}</h3>
            <p>{room?.kind === 'private' ? 'Only people with the invite link can join. Messages are end-to-end encrypted.' : room?.locked ? 'Messages here are end-to-end encrypted with the room password.' : 'Messages are relayed live and stored only on the devices of people here.'}</p>
            {canInvite && <div className="row-actions"><button className="primary" onClick={() => set({ dialog: 'invite', inviteRoom: room!.id })}>Invite people</button></div>}
          </div>
        ) : list.map((m) => {
          const day = formatDay(m.sentAt);
          const divider = day !== lastDay ? <div className="day-divider" key={`d-${m.clientMessageId}`}><span>{day}</span></div> : null;
          lastDay = day;
          return [divider, <Message key={m.clientMessageId} m={m} mine={m.author.publicKey === identity?.publicKeySpki} onView={setViewing} />];
        })}
      </div>

      {pendingImage && (
        <div className="attachment-preview">
          <img src={imageSrc(pendingImage)} alt="Image to send" />
          <div><strong>Image ready</strong><small>{pendingImage.width}×{pendingImage.height} · {Math.round((pendingImage.data.length * 3) / 4 / 1024)} KB{room?.locked ? ' · will be encrypted' : ''}</small></div>
          <button type="button" className="icon-button" aria-label="Remove image" onClick={() => setPendingImage(null)}>✕</button>
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void attach(e.target.files?.[0])} />
        <button type="button" className="icon-button attach" aria-label="Attach an image" title="Attach an image" disabled={processing} onClick={() => fileInput.current?.click()}>{processing ? '…' : '🖼'}</button>
        <textarea rows={1} value={draft} maxLength={LIMITS.messageChars} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onPaste={onPaste}
          placeholder={conn === 'online' ? `Message ${room?.name ?? ''}` : 'Offline: messages will send when you reconnect'} aria-label="Write a message" />
        <button type="submit" className="primary" disabled={!draft.trim() && !pendingImage}>Send <span aria-hidden="true">↗</span></button>
      </form>
      {dragging && <div className="drop-hint" aria-hidden="true">Drop an image to send</div>}
      {viewing && (
        <Modal title="Image" onClose={() => setViewing(null)} wide>
          <img className="image-full" src={imageSrc(viewing)} alt="Full size" />
        </Modal>
      )}
    </section>
  );
}

function Message({ m, mine, onView }: { m: LocalMessage; mine: boolean; onView: (img: ImageAttachment) => void }) {
  const hue = hueFor(m.author.publicKey);
  // Images from other people start blurred: this is an open app where strangers can post.
  const [revealed, setRevealed] = useState(mine);
  return (
    <article className={`message ${mine ? 'mine' : ''} ${m.state}`}>
      <div className="message-avatar" aria-hidden="true" style={{ background: `hsl(${hue} 35% 20%)`, color: `hsl(${hue} 80% 75%)` }}>{initials(m.author.handle)}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{m.author.handle}</strong>
          <time dateTime={new Date(m.sentAt).toISOString()}>{formatTime(m.sentAt)}</time>
          {m.encrypted && <span className="badge" title="End-to-end encrypted">🔒</span>}
          {m.state === 'pending' && <span className="badge">sending…</span>}
          {m.state === 'failed' && <span className="badge error">failed{m.error ? `: ${m.error}` : ''} <button className="link" onClick={() => void retryMessage(m)}>retry</button></span>}
        </div>
        {m.text && <p>{m.text}</p>}
        {m.image && (
          <button type="button" className={`image-message ${revealed ? '' : 'blurred'}`} style={{ aspectRatio: `${m.image.width} / ${m.image.height}` }}
            onClick={() => (revealed ? onView(m.image!) : setRevealed(true))} aria-label={revealed ? 'Open image' : 'Show image (hidden until you tap)'}>
            <img src={imageSrc(m.image)} alt={m.text ? `Image: ${m.text.slice(0, 80)}` : `Image from ${m.author.handle}`} loading="lazy" />
            {!revealed && <span className="reveal">Tap to show image</span>}
          </button>
        )}
      </div>
    </article>
  );
}
