import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { LIMITS } from '@pulse/protocol';
import { usePulse } from '../store';
import { leaveRoom, pinRoom, retryMessage, sendChat } from '../lib/client';
import type { LocalMessage } from '../lib/db';
import { formatDay, formatTime, hueFor, initials } from './util';

export function ChatView() {
  const { activeRoom, directory, messages, conn, identity, set } = usePulse();
  const room = directory.find((r) => r.id === activeRoom) ?? null;
  const list = (activeRoom && messages[activeRoom]) || [];
  const [draft, setDraft] = useState('');
  const [showRules, setShowRules] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const isOwner = !!room && !!identity && room.ownerKey === identity.publicKeySpki;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list.length, activeRoom]);

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

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || !activeRoom) return;
    void sendChat(activeRoom, text);
    setDraft('');
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  }

  let lastDay = '';
  return (
    <section className="chat panel" aria-label={`Chat in ${room?.name ?? activeRoom}`}>
      <header className="chat-header">
        <div className="chat-title">
          <span className="room-emoji" aria-hidden="true">{room?.emoji ?? '#'}</span>
          <div>
            <div className="eyebrow">{room?.kind === 'private' ? 'PRIVATE ROOM' : 'PUBLIC ROOM'}{room && room.slowModeSec > 0 ? ` · SLOW MODE ${room.slowModeSec}s` : ''}</div>
            <h2>{room?.name ?? activeRoom}</h2>
            {room?.topic && <p>{room.topic}</p>}
          </div>
        </div>
        <div className="chat-actions">
          <div className="member-count" aria-label={`${room?.members ?? 0} people here`}>{room?.members ?? 0} <span>here</span></div>
          {room?.rules && <button className="ghost-button small" aria-expanded={showRules} onClick={() => setShowRules((v) => !v)}>Rules</button>}
          {isOwner && room && <button className="ghost-button small" onClick={() => pinRoom(room.id, !room.pinned)}>{room.pinned ? 'Unpin' : 'Pin'}</button>}
          {activeRoom !== 'lobby' && <button className="ghost-button small" onClick={() => leaveRoom(activeRoom)}>Leave</button>}
        </div>
      </header>
      {showRules && room?.rules && <div className="rules" role="note"><strong>Room rules</strong><p>{room.rules}</p></div>}

      <div className="messages" ref={scroller} role="log" aria-live="polite" aria-relevant="additions">
        {list.length === 0 ? (
          <div className="empty-state">
            <div className="pulse-ring" aria-hidden="true">◉</div>
            <h3>Welcome to {room?.name ?? 'this room'}</h3>
            <p>Messages are relayed live and stored only on the devices of people here.</p>
          </div>
        ) : list.map((m) => {
          const day = formatDay(m.sentAt);
          const divider = day !== lastDay ? <div className="day-divider" key={`d-${m.clientMessageId}`}><span>{day}</span></div> : null;
          lastDay = day;
          return [divider, <Message key={m.clientMessageId} m={m} mine={m.author.publicKey === identity?.publicKeySpki} />];
        })}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea rows={1} value={draft} maxLength={LIMITS.messageChars} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
          placeholder={conn === 'online' ? `Message ${room?.name ?? ''}` : 'Offline: messages will send when you reconnect'} aria-label="Write a message" />
        <button type="submit" className="primary" disabled={!draft.trim()}>Send <span aria-hidden="true">↗</span></button>
      </form>
    </section>
  );
}

function Message({ m, mine }: { m: LocalMessage; mine: boolean }) {
  const hue = hueFor(m.author.publicKey);
  return (
    <article className={`message ${mine ? 'mine' : ''} ${m.state}`}>
      <div className="message-avatar" aria-hidden="true" style={{ background: `hsl(${hue} 35% 20%)`, color: `hsl(${hue} 80% 75%)` }}>{initials(m.author.handle)}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{m.author.handle}</strong>
          <time dateTime={new Date(m.sentAt).toISOString()}>{formatTime(m.sentAt)}</time>
          {m.state === 'pending' && <span className="badge">sending…</span>}
          {m.state === 'failed' && <span className="badge error">failed{m.error ? `: ${m.error}` : ''} <button className="link" onClick={() => void retryMessage(m)}>retry</button></span>}
        </div>
        <p>{m.text}</p>
      </div>
    </article>
  );
}
