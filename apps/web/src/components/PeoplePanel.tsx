import { usePulse } from '../store';
import { hueFor, initials } from './util';

const LABEL = { online: 'Available', away: 'Away', dnd: 'Do not disturb', invisible: 'Invisible' } as const;

export function PeoplePanel() {
  const { presence, activeRoom, identity } = usePulse();
  const people = presence.filter((p) => activeRoom && p.rooms.includes(activeRoom));
  return (
    <aside className="rightbar panel" aria-labelledby="people-title">
      <div className="eyebrow">LIVE NOW</div>
      <h2 id="people-title">People</h2>
      <ul className="people">
        {people.map((p) => {
          const hue = hueFor(p.publicKey);
          return (
            <li className="person" key={p.publicKey}>
              <div className="person-avatar" aria-hidden="true" style={{ background: `hsl(${hue} 30% 20%)`, color: `hsl(${hue} 80% 78%)` }}>{initials(p.handle)}<i className={`dot ${p.status}`} /></div>
              <div><strong>{p.handle}{p.publicKey === identity?.publicKeySpki ? ' (you)' : ''}</strong><small>{LABEL[p.status]}</small></div>
            </li>
          );
        })}
        {people.length === 0 && <li className="muted">Nobody else is here right now.</li>}
      </ul>
      <div className="call-card">
        <span aria-hidden="true">▣</span>
        <div><strong>Voice &amp; video</strong><p>Calls are coming in the next phase.</p></div>
      </div>
    </aside>
  );
}
