import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from './api';
import { errorMessage } from './format';
import { PlayerControls } from './PlayerControls';
import { usePlayerShortcuts, usePlayerSurfaceClicks, usePlayerVisibility } from './usePlayerInteractions';
import { defaultPlayer } from './types';
import type { PlaybackMode, PlayerAction, PlayerOverlayAction, PlayerPresentation } from './types';
import './player-layout.css';

const initial: PlayerPresentation = { revision: -1, player: defaultPlayer, ui: { hasPrevious: false, hasNext: false, mini: false, theater: false, fullscreen: false }, pausedIntent: false, overlayError: null };
export default function PlayerOverlay() {
  const [presentation, setPresentation] = useState(initial), [error, setError] = useState('');
  const surface = useRef<HTMLDivElement>(null);
  const revision = useRef(-1), current = useRef(presentation); current.current = presentation;
  useLayoutEffect(() => {
    let disposed = false, stop: (() => void) | undefined;
    const accept = (value: PlayerPresentation) => { if (!disposed && value.revision > revision.current) { revision.current = value.revision; setPresentation(value); } };
    const snapshot = () => { void api.playerPresentation().then(accept).catch(value => !disposed && setError(errorMessage(value))); };
    void api.on<PlayerPresentation>('player-presentation', accept).then(unlisten => { if (disposed) unlisten(); else { stop = unlisten; snapshot(); } }).catch(value => !disposed && setError(errorMessage(value)));
    // Read immediately as well: a hidden WebView may defer listen's JS reply
    // until its first paint, while the snapshot's native ready handshake is
    // what makes that window visible. Re-read after registration closes gaps.
    snapshot();
    return () => { disposed = true; stop?.(); };
  }, []);
  const send = useCallback((action: PlayerOverlayAction, value?: number, mode?: PlaybackMode) => { const load = current.current.player.loadId; if (!load) return; void api.overlayAction(load, action, value, mode).catch(value => { if (current.current.player.loadId === load && value?.code !== 'cancelled') setError(errorMessage(value)); }); }, []);
  const onAction = useCallback((action: PlayerAction, value?: number) => send(action, value), [send]);
  const onMode = useCallback((mode: PlaybackMode) => send('mode', undefined, mode), [send]);
  const onFullscreen = useCallback(() => send('fullscreen'), [send]);
  const visibility = usePlayerVisibility(presentation.player);
  const clicks = usePlayerSurfaceClicks(presentation.player.loadId, () => send('toggle'), onFullscreen);
  usePlayerShortcuts({ player: presentation.player, fullscreen: presentation.ui.fullscreen, onAction, onFullscreen, onFocusControls: () => send('focus-controls') });
  const { player, ui } = presentation;
  useEffect(() => {
    const stage = surface.current;
    if (!stage) return;
    let frame = 0, pending = 0;
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || current.current.ui.fullscreen || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
      const delta = event.deltaY * scale;
      if (!Number.isFinite(delta) || delta === 0) return;
      event.preventDefault();
      pending = Math.max(-4000, Math.min(4000, pending + delta));
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; const value = pending; pending = 0; send('scroll', value); });
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => { stage.removeEventListener('wheel', wheel); cancelAnimationFrame(frame); };
  }, [player.loadId, send]);
  useEffect(() => { setError(''); }, [player.loadId]);
  return <div ref={surface} className={`player-overlay-root player-host ${visibility.visible ? 'surface-controls-visible' : ''} ${ui.mini ? 'overlay-compact' : ''}`} aria-label="Video playback controls"
    onPointerEnter={visibility.reveal} onPointerMove={visibility.reveal} onPointerLeave={() => { visibility.hide(); clicks.cancel(); }}
    onPointerDown={clicks.onPointerDown} onPointerUp={clicks.onPointerUp} onPointerCancel={clicks.onPointerCancel}>
    {!ui.mini && <div className={`player-title-gradient ${visibility.visible ? 'visible' : ''}`}><span>{player.video?.title}</span></div>}
    <div className="audio-overlay-controls" inert={!visibility.visible}>
      <PlayerControls player={player} audio={false} compact={ui.mini} visible={visibility.visible} fullscreen={ui.fullscreen} theater={ui.theater} hasPrevious={ui.hasPrevious} hasNext={ui.hasNext} onAction={onAction} onMode={onMode} onPrevious={() => send('previous')} onNext={() => send('next')} onFullscreen={onFullscreen} onTheater={() => send('theater')} onMinimize={() => send('minimize')} onMenuChange={visibility.onMenuChange} onDragging={visibility.onDragging} />
    </div>
    {player.status === 'buffering' && !presentation.pausedIntent && <div className="overlay-buffering" aria-label="Buffering"><LoaderCircle size={34} className="spin" /></div>}
    {error && <div className="overlay-control-error" role="status">{error}</div>}
  </div>;
}
