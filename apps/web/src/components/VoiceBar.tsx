import { usePulse } from '../store';
import { joinVoice, leaveVoice, toggleMute } from '../lib/voice';
import { hueFor, initials } from './util';

/** Voice channel strip for a room: who's in, who's speaking, and join/mute/leave controls. */
export function VoiceBar({ roomId }: { roomId: string }) {
  const { voice, voiceRooms, speaking, peerStates, conn } = usePulse();
  const participants = voiceRooms[roomId] ?? [];
  const inThisRoom = voice?.roomId === roomId;
  const selfId = inThisRoom ? voice?.selfId : null;

  return (
    <div className={`voice-bar ${inThisRoom ? 'active' : ''}`} role="region" aria-label="Voice channel">
      <div className="voice-info">
        <span className="voice-icon" aria-hidden="true">🔊</span>
        <div>
          <strong>Voice</strong>
          <small>
            {participants.length === 0 ? 'Nobody is talking yet' : `${participants.length} in voice`}
            {inThisRoom && voice?.connecting ? ' · connecting…' : ''}
          </small>
        </div>
      </div>
      <ul className="voice-people" aria-label="People in voice">
        {participants.map((p) => {
          const isSelf = inThisRoom && p.sessionId === selfId;
          const talking = isSelf ? speaking.self : speaking[p.sessionId];
          const state = peerStates[p.sessionId];
          const hue = hueFor(p.publicKey);
          return (
            <li key={p.sessionId} className={`voice-person ${talking ? 'speaking' : ''}`} title={`${p.handle}${p.muted ? ' (muted)' : ''}${state && state !== 'connected' ? ` · ${state}` : ''}`}>
              <span className="voice-avatar" style={{ background: `hsl(${hue} 35% 22%)`, color: `hsl(${hue} 80% 78%)` }}>{initials(p.handle)}</span>
              <span className="voice-name">{p.handle}{p.muted ? ' 🔇' : ''}{state && state !== 'connected' && !isSelf ? ' …' : ''}</span>
            </li>
          );
        })}
      </ul>
      <div className="voice-controls">
        {inThisRoom ? (
          <>
            <button className={`ghost-button small ${voice?.muted ? 'on' : ''}`} onClick={toggleMute} aria-pressed={voice?.muted}>{voice?.muted ? '🔇 Unmute' : '🎙 Mute'}</button>
            <button className="danger small" onClick={leaveVoice}>Leave voice</button>
          </>
        ) : (
          <button className="primary small" disabled={conn !== 'online'} onClick={() => void joinVoice(roomId)}>🎙 Join voice</button>
        )}
      </div>
    </div>
  );
}
