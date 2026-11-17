import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { isDesktop } from './api';

/** These buttons replace Windows decorations only for the trusted main window. */
export function WindowControls({ onError }: { onError: (error: unknown) => void }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const current = getCurrentWindow();
      const update = async () => { const value = await current.isMaximized(); if (!disposed) setMaximized(value); };
      await update();
      const stop = await current.onResized(() => { void update().catch(onError); });
      if (disposed) stop(); else unlisten = stop;
    }).catch(onError);
    return () => { disposed = true; unlisten?.(); };
  }, [onError]);
  function run(action: 'minimize' | 'toggleMaximize' | 'close') {
    if (isDesktop) void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const current = getCurrentWindow();
      await current[action]();
      if (action === 'toggleMaximize') setMaximized(await current.isMaximized());
    }).catch(onError);
  }
  return <div className="window-controls" aria-label="Window controls">
    <button aria-label="Minimize window" title="Minimize" disabled={!isDesktop} onClick={() => run('minimize')}><Minus size={17} /></button>
    <button aria-label={maximized ? 'Restore window' : 'Maximize window'} title={maximized ? 'Restore' : 'Maximize'} disabled={!isDesktop} onClick={() => run('toggleMaximize')}>{maximized ? <Copy size={14} /> : <Square size={14} />}</button>
    <button className="window-close" aria-label="Close window" title="Close" disabled={!isDesktop} onClick={() => run('close')}><X size={18} /></button>
  </div>;
}
