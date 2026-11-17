import { memo, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { ArrowLeft, Check, ChevronRight, Gauge, Headphones, Maximize, Music2, Pause, Play, RectangleHorizontal, Settings, SkipBack, SkipForward, SlidersHorizontal, Video, Volume2, VolumeX } from 'lucide-react';
import { time } from './format';
import { IconButton } from './ui';
import type { PlaybackMode, PlayerAction, PlayerState } from './types';

interface SettingsProps { player: PlayerState; audio: boolean; visible?: boolean; onAction: (action: PlayerAction, value?: number) => void; onMode: (mode: PlaybackMode) => void; onMenuChange?: (open: boolean) => void }
export function PlayerSettings({ player, audio, visible = true, onAction, onMode, onMenuChange }: SettingsProps) {
  const [menu, setMenu] = useState<'root' | 'speed' | 'quality' | 'mode' | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!visible) setMenu(null); }, [visible]);
  useEffect(() => { setMenu(null); }, [player.loadId]);
  useEffect(() => { onMenuChange?.(!!menu); }, [menu, onMenuChange]);
  useEffect(() => {
    if (!menu) return;
    container.current?.querySelector<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')?.focus();
    function dismiss(event: PointerEvent) { if (!container.current?.contains(event.target as Node)) setMenu(null); }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  function close() { setMenu(null); trigger.current?.focus(); }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const entries = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]') ?? []).filter(button => !button.disabled);
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); entries[(index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus(); }
  }
  return <div ref={container} className={`player-settings ${audio ? 'settings-over-art' : ''}`} onKeyDown={keys}>
    <button ref={trigger} className="icon-button" title="Playback settings" aria-label="Playback settings" aria-haspopup="menu" aria-expanded={!!menu} onClick={() => setMenu(value => value ? null : 'root')}><Settings size={21} /></button>
    {menu && <div className="player-settings-menu" role="menu" aria-label="Playback settings" data-player-menu>
      {menu !== 'root' && <button className="settings-menu-back" role="menuitem" onClick={() => setMenu('root')}><ArrowLeft size={18} />{menu === 'speed' ? 'Playback speed' : menu === 'quality' ? 'Quality' : 'Playback mode'}</button>}
      {menu === 'root' && <>
        <button role="menuitem" onClick={() => setMenu('mode')}><Headphones size={21} /><span>Playback mode</span><small>{audio ? 'Audio only' : 'Video'}</small><ChevronRight size={18} /></button>
        <button role="menuitem" onClick={() => setMenu('speed')}><Gauge size={21} /><span>Playback speed</span><small>{player.speed === 1 ? 'Normal' : `${player.speed}×`}</small><ChevronRight size={18} /></button>
        <button role="menuitem" disabled={audio || !player.qualities.length} onClick={() => setMenu('quality')}><SlidersHorizontal size={21} /><span>Quality</span><small>{audio ? 'Audio only' : `${player.quality}p`}</small><ChevronRight size={18} /></button>
      </>}
      {menu === 'mode' && (['video', 'audio'] as const).map(mode => <button role="menuitemradio" aria-checked={(audio ? 'audio' : 'video') === mode} key={mode} onClick={() => { onMode(mode); close(); }}><span className="menu-check">{(audio ? 'audio' : 'video') === mode && <Check size={17} />}</span>{mode === 'video' ? <Video size={18} /> : <Music2 size={18} />}<span>{mode === 'video' ? 'Video' : 'Audio only'}</span></button>)}
      {menu === 'speed' && [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(speed => <button role="menuitemradio" aria-checked={player.speed === speed} key={speed} onClick={() => { onAction('speed', speed); close(); }}><span className="menu-check">{player.speed === speed && <Check size={17} />}</span><span>{speed === 1 ? 'Normal' : `${speed}×`}</span></button>)}
      {menu === 'quality' && [...player.qualities].sort((a, b) => b - a).map(quality => <button role="menuitemradio" aria-checked={player.quality === quality} key={quality} onClick={() => { onAction('quality', quality); close(); }}><span className="menu-check">{player.quality === quality && <Check size={17} />}</span><span>{quality}p</span>{quality >= 1080 && <small>HD</small>}</button>)}
    </div>}
  </div>;
}

interface ControlsProps {
  player: PlayerState; audio: boolean; compact?: boolean; visible?: boolean; variant?: 'surface' | 'accessible' | 'dock';
  fullscreen: boolean; theater: boolean; hasPrevious: boolean; hasNext: boolean;
  onAction: (action: PlayerAction, value?: number) => void; onMode: (mode: PlaybackMode) => void;
  onPrevious: () => void; onNext: () => void; onFullscreen: () => void; onTheater: () => void; onRetry?: () => void;
  onMenuChange?: (open: boolean) => void; onDragging?: (active: boolean) => void;
}

function usePlaybackPosition(player: PlayerState, active: boolean) {
  const slider = useRef<HTMLInputElement>(null), dragging = useRef(false);
  const anchor = useRef({ position: player.position, time: performance.now(), player });
  const [position, setPosition] = useState(player.position);
  const draw = (value: number) => {
    const input = slider.current;
    if (input && !dragging.current) input.value = String(value);
    input?.style.setProperty('--range-progress', `${anchor.current.player.duration ? Math.min(100, value / anchor.current.player.duration * 100) : 0}%`);
    setPosition(previous => Math.floor(previous) === Math.floor(value) ? previous : value);
  };
  useEffect(() => {
    anchor.current = { position: player.position, time: performance.now(), player };
    if (!dragging.current) draw(player.position);
  }, [player.position, player.duration, player.status, player.speed, player.loadId]);
  useEffect(() => { dragging.current = false; }, [player.loadId]);
  useEffect(() => {
    if (!active || player.status !== 'playing') return;
    let frame = 0;
    const tick = () => {
      const current = anchor.current;
      if (!dragging.current) draw(Math.min(current.player.duration, Math.max(0, current.position + (performance.now() - current.time) / 1000 * current.player.speed)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, player.status, player.loadId]);
  return { slider, dragging, position, preview: (value: number) => { setPosition(value); slider.current?.style.setProperty('--range-progress', `${player.duration ? value / player.duration * 100 : 0}%`); }, commit: (value: number) => { anchor.current = { position: value, time: performance.now(), player }; draw(value); } };
}

export function VolumeControl({ player, onAction, compact = false }: { player: PlayerState; onAction: ControlsProps['onAction']; compact?: boolean }) {
  return <div className="volume-control"><IconButton label={player.muted ? 'Unmute (M)' : 'Mute (M)'} onClick={() => onAction('mute', player.muted ? 0 : 1)}>{player.muted || !player.volume ? <VolumeX size={21} /> : <Volume2 size={21} />}</IconButton>{!compact && <input data-player-range type="range" min="0" max="100" value={player.volume} onChange={event => onAction('volume', Number(event.target.value))} aria-label="Volume" aria-valuetext={`${Math.round(player.volume)}%${player.muted ? ', muted' : ''}`} />}</div>;
}

export const PlayerControls = memo(function PlayerControls({ player, audio, compact = false, visible = true, variant = 'surface', fullscreen, theater, hasPrevious, hasNext, onAction, onMode, onPrevious, onNext, onFullscreen, onTheater, onRetry, onMenuChange, onDragging }: ControlsProps) {
  const seekId = useId(), progress = usePlaybackPosition(player, visible);
  const pointerLoad = useRef(player.loadId), cancelledSeek = useRef(false);
  const busy = ['resolving', 'preparing'].includes(player.status), playing = ['playing', 'buffering'].includes(player.status);
  useEffect(() => { if (pointerLoad.current !== player.loadId) cancelledSeek.current = true; progress.dragging.current = false; onDragging?.(false); }, [player.loadId]);
  function finishSeek(commit: boolean) {
    if (!progress.dragging.current) return;
    progress.dragging.current = false; onDragging?.(false);
    if (commit && !cancelledSeek.current && pointerLoad.current === player.loadId && progress.slider.current) {
      const value = Number(progress.slider.current.value); progress.commit(value); onAction('seek', value);
    } else progress.commit(player.position);
  }
  const seek = <><label className="sr-only" htmlFor={seekId}>Playback position</label><input ref={progress.slider} data-player-range id={seekId} className="seek-slider" type="range" min="0" max={Math.max(1, player.duration)} step="0.1" defaultValue={player.position} style={{ '--range-progress': `${player.duration ? player.position / player.duration * 100 : 0}%` } as CSSProperties}
    onPointerDown={event => { cancelledSeek.current = false; pointerLoad.current = player.loadId; progress.dragging.current = true; onDragging?.(true); event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerUp={() => finishSeek(true)} onPointerCancel={() => { cancelledSeek.current = true; finishSeek(false); }} onLostPointerCapture={() => { if (progress.dragging.current) { cancelledSeek.current = true; finishSeek(false); } }} onKeyDown={() => { cancelledSeek.current = false; }}
    onChange={event => { if (cancelledSeek.current) return; const value = Number(event.target.value); progress.preview(value); if (!progress.dragging.current) { progress.commit(value); onAction('seek', value); } }}
    disabled={busy || !player.duration} aria-valuetext={`${time(progress.position)} of ${time(player.duration)}`} /></>;
  const transport = <><IconButton label="Previous video" disabled={!hasPrevious} onClick={onPrevious}><SkipBack size={20} fill="currentColor" /></IconButton><IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={busy} onClick={() => ['ended', 'failed'].includes(player.status) && onRetry ? onRetry() : onAction('toggle')} className={variant === 'dock' ? 'bottom-play-button' : 'play-control'}>{playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}</IconButton><IconButton label="Next video" disabled={!hasNext} onClick={onNext}><SkipForward size={20} fill="currentColor" /></IconButton></>;
  if (variant === 'dock') return <div className="bottom-player-transport shared-player-controls" role="group" aria-label="Playback controls"><div className="bottom-transport-buttons">{transport}</div><div className="bottom-player-progress"><span>{time(progress.position)}</span>{seek}<span>{time(player.duration)}</span></div></div>;
  return <div className={`player-controls html-player-controls shared-player-controls ${compact ? 'compact-controls' : ''} ${variant === 'surface' ? 'surface-player-controls' : ''}`} data-player-interactive>
    {seek}<div className="control-row"><div className="control-group">{transport}<VolumeControl player={player} onAction={onAction} compact={compact} /><span className="player-time">{time(progress.position)}<span> / {time(player.duration)}</span></span></div>
      <div className="control-group right-controls"><PlayerSettings player={player} audio={audio} visible={visible} onAction={onAction} onMode={onMode} onMenuChange={onMenuChange} />{!compact && <IconButton label={theater ? 'Exit theater mode' : 'Theater mode'} onClick={onTheater}><RectangleHorizontal size={21} /></IconButton>}<IconButton label={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} onClick={onFullscreen}><Maximize size={21} /></IconButton></div>
    </div>
  </div>;
});
