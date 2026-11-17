import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, Headphones, Keyboard, LoaderCircle, Maximize, Minimize2, Music2, Video, X } from 'lucide-react';
import { api, isDesktop } from './api';
import { IconButton } from './ui';
import { PlayerControls, PlayerSettings, VolumeControl } from './PlayerControls';
import { useBlockingModal, usePlayerSurfaceClicks, usePlayerVisibility } from './usePlayerInteractions';
import './player-layout.css';
import type { PlaybackMode, PlayerAction, PlayerState, PlayerPresentation } from './types';

interface Props {
  player: PlayerState; mini: boolean; docked: boolean; fullscreen: boolean; theater: boolean; blocked: boolean;
  hasPrevious: boolean; hasNext: boolean; focusSignal: number;
  onAction: (action: PlayerAction, value?: number) => void; onMode: (mode: PlaybackMode) => void;
  onPrevious: () => void; onNext: () => void; onFullscreen: () => void; onTheater: () => void;
  onExpand: () => void; onDock: () => void; onUndock: () => void; onClose: () => void; onRetry: () => void;
}

/** One mounted host owns the sole native surface in both Watch and mini layouts. */
export function PlayerHost(props: Props) {
  const { player, mini, docked, fullscreen, theater, blocked, hasPrevious, hasNext, focusSignal, onAction, onMode, onPrevious, onNext, onFullscreen, onTheater, onExpand, onDock, onUndock, onClose, onRetry } = props;
  const surface = useRef<HTMLDivElement>(null);
  const lastBounds = useRef('');
  const modalOpen = useBlockingModal();
  const effectiveBlocked = blocked || modalOpen;
  const controls = useRef<HTMLDivElement>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const visibility = usePlayerVisibility(player);
  const clicks = usePlayerSurfaceClicks(player.loadId, () => onAction('toggle'), onFullscreen);
  const overlayVisible = visibility.visible;
  const [overlayError, setOverlayError] = useState<string | null>(null);
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false, stop: (() => void) | undefined;
    const accept = (value: PlayerPresentation) => { if (!disposed) setOverlayError(value.overlayError); };
    void api.on<PlayerPresentation>('player-presentation', accept).then(unlisten => { if (disposed) unlisten(); else { stop = unlisten; void api.playerPresentation().then(accept).catch(() => {}); } });
    return () => { disposed = true; stop?.(); };
  }, []);
  const panelId = useId();
  const audio = player.playbackMode === 'audio';
  const hasVideo = !!player.video;
  const lastFocus = useRef(focusSignal);
  useEffect(() => {
    if (lastFocus.current === focusSignal) return;
    lastFocus.current = focusSignal;
    setControlsOpen(true);
    requestAnimationFrame(() => controls.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
  }, [focusSignal]);
  useEffect(() => {
    if (!isDesktop) return;
    let frame = 0;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = surface.current?.getBoundingClientRect();
        const scale = window.devicePixelRatio || 1;
        const visible = hasVideo && !audio && !docked && !effectiveBlocked && ['playing', 'paused', 'preparing', 'buffering'].includes(player.status) && !!rect && rect.width > 0 && rect.height > 0 && rect.top >= (fullscreen ? 0 : 64) && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
        const bounds = { x: (rect?.x ?? 0) * scale, y: (rect?.y ?? 0) * scale, width: (rect?.width ?? 0) * scale, height: (rect?.height ?? 0) * scale, visible, radius: fullscreen ? 0 : 12 * scale };
        const key = JSON.stringify(bounds);
        if (lastBounds.current !== key) { lastBounds.current = key; void api.playerBounds(bounds).catch(() => { lastBounds.current = ''; }); }
      });
    }
    const observer = new ResizeObserver(update); if (surface.current) observer.observe(surface.current);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true); update();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [hasVideo, audio, effectiveBlocked, player.status, mini, docked, fullscreen, theater, controlsOpen]);

  if (!player.video) return <div className="player-host player-host-empty" hidden />;
  const busy = player.status === 'resolving' || player.status === 'preparing';
  function renderControls(compact = false, accessible = false) {
    return <PlayerControls player={player} audio={audio} compact={compact} visible={accessible ? controlsOpen || !!overlayError : overlayVisible || docked} variant={accessible ? 'accessible' : 'surface'} fullscreen={fullscreen} theater={theater} hasPrevious={hasPrevious} hasNext={hasNext} onAction={onAction} onMode={onMode} onPrevious={onPrevious} onNext={onNext} onFullscreen={onFullscreen} onTheater={onTheater} onRetry={onRetry} onMenuChange={visibility.onMenuChange} onDragging={visibility.onDragging} />;
  }
  return <section className={`player-host ${mini ? 'mini-player' : 'full-player'} ${docked ? 'bottom-player' : ''} ${audio ? 'audio-player' : ''} ${overlayVisible ? 'surface-controls-visible' : ''} ${controlsOpen ? 'controls-revealed' : ''}`} aria-label={docked ? 'Bottom player' : mini ? 'Mini player' : 'Video player'}>
    <div className="player-surface" ref={surface} aria-hidden={docked || undefined}
      onPointerEnter={visibility.reveal} onPointerMove={visibility.reveal} onPointerLeave={() => { visibility.hide(); clicks.cancel(); }}
      onPointerDown={clicks.onPointerDown} onPointerUp={clicks.onPointerUp} onPointerCancel={clicks.onPointerCancel}
      onFocusCapture={event => { if ((event.target as HTMLElement).matches(':focus-visible')) visibility.reveal(); }}>
      {audio && <div className="audio-stage">
        {player.video.thumbnail && <img className="audio-backdrop" src={player.video.thumbnail} alt="" referrerPolicy="no-referrer" />}
        <div className="audio-mode-tag"><Headphones size={16} />Audio only</div>
        <button className="audio-art-button" data-player-surface-toggle aria-label={player.status === 'paused' ? 'Play audio' : 'Pause audio'} onClick={event => { if (event.detail === 0) onAction('toggle'); }}>{player.video.thumbnail ? <img src={player.video.thumbnail} alt="" referrerPolicy="no-referrer" /> : <Music2 size={56} />}<span>{player.video.title}</span></button>
      </div>}
      {busy && <div className="player-placeholder loading-player"><LoaderCircle className="spin" size={34} /><p>Getting your {audio ? 'audio' : 'video'} ready…</p></div>}
      {player.status === 'failed' && <div className="player-placeholder player-error"><AlertCircle size={34} /><h2>Couldn’t play this {audio ? 'audio' : 'video'}</h2><p>{player.error || 'Try again or choose another video.'}</p><button className="button light" onClick={onRetry}>Try again</button></div>}
      {audio && !['failed', 'resolving'].includes(player.status) && <div className="audio-overlay-controls" inert={!overlayVisible}>{renderControls(mini)}</div>}
    </div>
    {!audio && !mini && <div className="accessible-controls"><button className="a11y-controls-toggle" aria-expanded={controlsOpen} aria-controls={panelId} onClick={() => setControlsOpen(value => !value)}><Keyboard size={15} />Keyboard controls</button><div ref={controls} id={panelId} hidden={!controlsOpen && !overlayError} role="group" aria-label="Accessible player controls">{renderControls(false, true)}</div>{overlayError && <div className="overlay-fallback" role="status"><span>Video controls couldn’t open. Keyboard controls are available.</span><button className="button secondary small" onClick={() => void api.retryPlayerOverlay().catch(() => setOverlayError('retry_failed'))}>Retry controls</button></div>}</div>}
    {mini && !docked && <div className="mini-player-footer"><button className="mini-player-title" onClick={onExpand}><strong>{player.video.title}</strong><span>{player.video.channel}</span></button><IconButton label="Move player to bottom bar" onClick={onDock}><ChevronDown size={19} /></IconButton><IconButton label="Expand player" onClick={onExpand}><Maximize size={17} /></IconButton><IconButton label="Close player" onClick={onClose}><X size={19} /></IconButton></div>}
    {docked && <div className="bottom-player-content">
      <div className="bottom-player-track"><button className="bottom-player-art" aria-label="Open now playing" onClick={onExpand}>{player.video.thumbnail ? <img src={player.video.thumbnail} alt="" referrerPolicy="no-referrer" /> : <Music2 size={25} />}</button><button className="bottom-player-copy" onClick={onExpand}><strong>{player.video.title}</strong><span>{player.status === 'failed' ? player.error || 'Playback failed' : busy ? 'Getting ready…' : player.video.channel}</span></button>{audio && <Headphones size={16} className="bottom-audio-indicator" aria-label="Audio only" />}</div>
      <PlayerControls player={player} audio={audio} variant="dock" visible fullscreen={fullscreen} theater={theater} hasPrevious={hasPrevious} hasNext={hasNext} onAction={onAction} onMode={onMode} onPrevious={onPrevious} onNext={onNext} onFullscreen={onFullscreen} onTheater={onTheater} onRetry={onRetry} />
      <div className="bottom-player-options"><PlayerSettings player={player} audio={audio} onAction={onAction} onMode={onMode} /><VolumeControl player={player} onAction={onAction} /><IconButton label="Restore floating mini player" onClick={onUndock}><ChevronUp size={20} /></IconButton><IconButton label="Expand player" onClick={onExpand}><Maximize size={18} /></IconButton><IconButton label="Close player" onClick={onClose}><X size={18} /></IconButton></div>
    </div>}
    {!mini && !audio && <button className="mode-quick-toggle" onClick={() => onMode('audio')}><Headphones size={15} />Listen with audio only</button>}
    {!mini && audio && <button className="mode-quick-toggle" onClick={() => onMode('video')}><Video size={15} />Switch to video</button>}
    {mini && controlsOpen && <button className="sr-only" onClick={onExpand}><Minimize2 size={16} />Open full player controls</button>}
  </section>;
}
