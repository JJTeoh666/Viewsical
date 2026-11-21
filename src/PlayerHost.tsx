import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, Headphones, LoaderCircle, Maximize, Music2, Video, X } from 'lucide-react';
import { api, isDesktop } from './api';
import { IconButton } from './ui';
import { PlayerControls, PlayerSettings, VolumeControl } from './PlayerControls';
import { useBlockingModal, usePlayerSurfaceClicks, usePlayerVisibility } from './usePlayerInteractions';
import { useVideoCanvas } from './useVideoCanvas';
import { playerViewport } from './playerViewport';
import './player-layout.css';
import type { PlaybackMode, PlayerAction, PlayerState, PlayerPresentation } from './types';

interface Props {
  player: PlayerState; mini: boolean; docked: boolean; fullscreen: boolean; theater: boolean; blocked: boolean;
  hasPrevious: boolean; hasNext: boolean; focusSignal: number;
  onAction: (action: PlayerAction, value?: number) => void; onMode: (mode: PlaybackMode) => void;
  onPrevious: () => void; onNext: () => void; onFullscreen: () => void; onTheater: () => void; onMinimize?: () => void;
  onExpand: () => void; onDock: () => void; onUndock: () => void; onClose: () => void; onRetry: () => void;
}

/** Keep one playback surface mounted through Watch, mini, and docked layouts. */
export function PlayerHost(props: Props) {
  const { player, mini, docked, fullscreen, theater, blocked, hasPrevious, hasNext, focusSignal, onAction, onMode, onPrevious, onNext, onFullscreen, onTheater, onMinimize, onExpand, onDock, onUndock, onClose, onRetry } = props;
  const surface = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const lastBounds = useRef('');
  const modalOpen = useBlockingModal();
  const effectiveBlocked = blocked || modalOpen;
  const controls = useRef<HTMLDivElement>(null);
  const [controlsFocused, setControlsFocused] = useState(false);
  const visibility = usePlayerVisibility(player);
  const clicks = usePlayerSurfaceClicks(player.loadId, () => onAction('toggle'), onFullscreen);
  const overlayVisible = visibility.visible;
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [pausedIntent, setPausedIntent] = useState(false);
  const audio = player.playbackMode === 'audio';
  const item = player.video;
  const hasVideo = !!item;
  const canvasMode = useVideoCanvas(canvas, surface, {
    loadId: player.loadId,
    hasVideo,
    audio,
    active: hasVideo && !audio && !docked && !effectiveBlocked && player.status !== 'failed',
  }) === 'canvas';
  const canvasVideo = canvasMode && !audio && !docked;
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false, stop: (() => void) | undefined;
    const accept = (value: PlayerPresentation) => {
      if (!disposed && value) { setOverlayError(value.overlayError); setPausedIntent(value.pausedIntent); }
    };
    void api.on<PlayerPresentation>('player-presentation', accept).then(unlisten => { if (disposed) unlisten(); else { stop = unlisten; void api.playerPresentation().then(accept).catch(() => {}); } });
    return () => { disposed = true; stop?.(); };
  }, []);
  const lastFocus = useRef(focusSignal);
  useEffect(() => {
    if (lastFocus.current === focusSignal) return;
    lastFocus.current = focusSignal;
    const frame = requestAnimationFrame(() => controls.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusSignal]);
  useEffect(() => {
    if (!isDesktop) return;
    if (canvasMode) { lastBounds.current = ''; return; }
    const header = document.querySelector('.topbar');
    const allowed = hasVideo && !audio && !docked && !effectiveBlocked && ['playing', 'paused', 'preparing', 'buffering', 'ended'].includes(player.status);
    let frame = 0;
    function reportBounds() {
      const rect = surface.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const headerBottom = header?.getBoundingClientRect().bottom ?? 64;
      const bounds = playerViewport(rect ?? { x: 0, y: 0, width: 0, height: 0 }, innerWidth, innerHeight, headerBottom, scale, allowed, fullscreen);
      const key = JSON.stringify(bounds);
      if (lastBounds.current === key) return;
      lastBounds.current = key;
      void api.playerBounds(bounds).catch(() => {
        if (lastBounds.current === key) lastBounds.current = '';
      });
    }
    function update() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        reportBounds();
      });
    }
    function onScroll(event: Event) {
      if (event.target instanceof Element && !event.target.contains(surface.current)) return;
      reportBounds();
      // A smooth or scripted scroll can advance again before the next paint.
      // Recheck in that frame and skip the request if the rectangle still agrees.
      update();
    }
    const observer = new ResizeObserver(update);
    if (surface.current) observer.observe(surface.current);
    if (header) observer.observe(header);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [canvasMode, hasVideo, audio, effectiveBlocked, player.status, mini, docked, fullscreen, theater, controlsFocused]);

  const busy = player.status === 'resolving' || player.status === 'preparing';
  const showOverlayError = canvasMode ? null : overlayError;
  useEffect(() => { if (!hasVideo || audio || mini) setControlsFocused(false); }, [hasVideo, audio, mini]);
  function renderControls(compact = false, accessible = false) {
    return <PlayerControls player={player} audio={audio} compact={compact} visible={accessible ? controlsFocused || !!showOverlayError : overlayVisible || docked} variant={accessible ? 'accessible' : 'surface'} fullscreen={fullscreen} theater={theater} hasPrevious={hasPrevious} hasNext={hasNext} onAction={onAction} onMode={onMode} onPrevious={onPrevious} onNext={onNext} onFullscreen={onFullscreen} onTheater={onTheater} onMinimize={onMinimize} onRetry={onRetry} onMenuChange={visibility.onMenuChange} onDragging={visibility.onDragging} />;
  }
  return <section className={`player-host ${hasVideo ? mini ? 'mini-player' : 'full-player' : 'player-host-empty'} ${docked ? 'bottom-player' : ''} ${audio ? 'audio-player' : ''} ${overlayVisible ? 'surface-controls-visible' : ''}`} hidden={!hasVideo} aria-label={docked ? 'Bottom player' : mini ? 'Mini player' : 'Video player'}>
    <div className={`player-surface${canvasVideo ? ' is-canvas-video' : ''}`} ref={surface} aria-hidden={docked || undefined}
      onPointerEnter={visibility.reveal} onPointerMove={visibility.reveal} onPointerLeave={() => { visibility.hide(); clicks.cancel(); }}
      onPointerDown={clicks.onPointerDown} onPointerUp={clicks.onPointerUp} onPointerCancel={clicks.onPointerCancel}
      onFocusCapture={event => { if ((event.target as HTMLElement).matches(':focus-visible')) visibility.reveal(); }}>
      <canvas className="video-frame-canvas" ref={canvas} width={1} height={1} hidden={!canvasVideo} aria-hidden="true" />
      {audio && item && <div className="audio-stage">
        {item.thumbnail && <img className="audio-backdrop" src={item.thumbnail} alt="" referrerPolicy="no-referrer" />}
        <div className="audio-mode-tag"><Headphones size={16} />Audio only</div>
        <button className="audio-art-button" data-player-surface-toggle aria-label={player.status === 'paused' || player.status === 'ended' ? 'Play audio' : 'Pause audio'} onClick={event => { if (event.detail === 0) onAction('toggle'); }}>{item.thumbnail ? <img src={item.thumbnail} alt="" referrerPolicy="no-referrer" /> : <Music2 size={56} />}<span>{item.title}</span></button>
      </div>}
      {busy && <div className="player-placeholder loading-player"><LoaderCircle className="spin" size={34} /><p>Getting your {audio ? 'audio' : 'video'} ready…</p></div>}
      {player.status === 'failed' && <div className="player-placeholder player-error"><AlertCircle size={34} /><h2>Couldn’t play this {audio ? 'audio' : 'video'}</h2><p>{player.error || 'Try again or choose another video.'}</p><button className="button light" onClick={onRetry}>Try again</button></div>}
      {canvasVideo && item && !mini && !busy && player.status !== 'failed' && <div className={`player-title-gradient ${overlayVisible ? 'visible' : ''}`}><span>{item.title}</span></div>}
      {canvasVideo && player.status === 'buffering' && !pausedIntent && <div className="overlay-buffering" aria-label="Buffering"><LoaderCircle size={34} className="spin" /></div>}
      {(audio || canvasVideo) && hasVideo && !['failed', 'resolving'].includes(player.status) && <div className="audio-overlay-controls" inert={!overlayVisible}>{renderControls(mini)}</div>}
    </div>
    {hasVideo && !audio && !mini && <div className={`accessible-controls${showOverlayError ? ' has-overlay-error' : ''}`}>
      <div ref={controls} role="group" aria-label="Accessible player controls"
        onFocus={() => setControlsFocused(true)}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlsFocused(false); }}>
        {renderControls(false, true)}
      </div>
      {showOverlayError && <div className="overlay-fallback" role="status"><span>Video controls couldn’t open. Keyboard controls are available.</span><button className="button secondary small" onClick={() => void api.retryPlayerOverlay().catch(() => setOverlayError('retry_failed'))}>Retry controls</button></div>}
    </div>}
    {mini && !docked && item && <div className="mini-player-footer"><button className="mini-player-title" onClick={onExpand}><strong>{item.title}</strong><span>{item.channel}</span></button><IconButton label="Move player to bottom bar" onClick={onDock}><ChevronDown size={19} /></IconButton><IconButton label="Expand player" onClick={onExpand}><Maximize size={17} /></IconButton><IconButton label="Close player" onClick={onClose}><X size={19} /></IconButton></div>}
    {docked && item && <div className="bottom-player-content">
      <div className="bottom-player-track"><button className="bottom-player-art" aria-label="Open now playing" onClick={onExpand}>{item.thumbnail ? <img src={item.thumbnail} alt="" referrerPolicy="no-referrer" /> : <Music2 size={25} />}</button><button className="bottom-player-copy" onClick={onExpand}><strong>{item.title}</strong><span>{player.status === 'failed' ? player.error || 'Playback failed' : busy ? 'Getting ready…' : item.channel}</span></button>{audio && <Headphones size={16} className="bottom-audio-indicator" aria-label="Audio only" />}</div>
      <PlayerControls player={player} audio={audio} variant="dock" visible fullscreen={fullscreen} theater={theater} hasPrevious={hasPrevious} hasNext={hasNext} onAction={onAction} onMode={onMode} onPrevious={onPrevious} onNext={onNext} onFullscreen={onFullscreen} onTheater={onTheater} onRetry={onRetry} />
      <div className="bottom-player-options"><PlayerSettings player={player} audio={audio} onAction={onAction} onMode={onMode} /><VolumeControl player={player} onAction={onAction} /><IconButton label="Restore floating mini player" onClick={onUndock}><ChevronUp size={20} /></IconButton><IconButton label="Expand player" onClick={onExpand}><Maximize size={18} /></IconButton><IconButton label="Close player" onClick={onClose}><X size={18} /></IconButton></div>
    </div>}
    {!mini && !audio && <button className="mode-quick-toggle" onClick={() => onMode('audio')}><Headphones size={15} />Listen with audio only</button>}
    {!mini && audio && <button className="mode-quick-toggle" onClick={() => onMode('video')}><Video size={15} />Switch to video</button>}
  </section>;
}
