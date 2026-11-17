import { useEffect, useRef, type ReactNode } from 'react';

/** Native <dialog>: focus trapping, Esc to close and inert background come from the browser. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby="modal-title" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="modal-body">
        <header className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
