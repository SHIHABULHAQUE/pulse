import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { usePulse } from './store';
import { boot } from './lib/client';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { PeoplePanel } from './components/PeoplePanel';
import { CreateRoomDialog, DirectoryDialog, SearchDialog, SettingsDialog } from './components/dialogs';
import './styles.css';

const CONN_LABEL = { online: 'Connected', connecting: 'Connecting…', offline: 'Offline: reconnecting' } as const;

function App() {
  const { conn, dialog, toasts, settings, set } = usePulse();

  useEffect(() => { void boot(); }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); set({ dialog: 'search' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to chat</a>
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">◉</div>
        <div><h1>Pulse</h1><p>Realtime, no account required</p></div>
        <span className={`status ${conn}`} role="status"><i aria-hidden="true" />{CONN_LABEL[conn]}</span>
      </header>
      <main className="layout" id="main">
        <Sidebar />
        <ChatView />
        <PeoplePanel />
      </main>
      {dialog === 'create' && <CreateRoomDialog />}
      {dialog === 'directory' && <DirectoryDialog />}
      {dialog === 'search' && <SearchDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      <div className="toasts" aria-live="assertive">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>{t.text}</div>)}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
