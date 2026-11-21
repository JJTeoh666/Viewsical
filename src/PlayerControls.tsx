import { memo, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowLeft, Captions, Check, ChevronRight, Gauge, Headphones, Maximize, Minimize, Music2, Pause, PictureInPicture2, Play, RectangleHorizontal, Settings, SkipBack, SkipForward, SlidersHorizontal, Video, Volume2, VolumeX } from 'lucide-react';
import { time } from './format';
import { chapterAt, SeekTimeline } from './SeekTimeline';
import { SubtitleOptions } from './SubtitleOptions';
import { IconButton } from './ui';
import type { PlaybackMode, PlayerAction, PlayerState, ReplayHeatmapInterval } from './types';

interface SettingsProps { player: PlayerState; audio: boolean; visible?: boolean; onAction: (action: PlayerAction, value?: number) => void; onMode: (mode: PlaybackMode) => void; onMenuChange?: (open: boolean) => void }
export function PlayerSettings({ player, audio, visible = true, onAction, onMode, onMenuChange }: SettingsProps) {
  const [menu, setMenu] = useState<'root' | 'speed' | 'quality' | 'mode' | 'subtitles' | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!visible) setMenu(null); }, [visible]);
  useEffect(() => { setMenu(null); }, [player.loadId]);
  useEffect(() => { if (audio && menu === 'subtitles') setMenu('root'); }, [audio, menu]);
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
  const hasVideoSource = !audio && !!player.video && ['playing', 'paused', 'buffering', 'ended'].includes(player.status);
  const quality = hasVideoSource && player.quality > 0 ? `${player.quality}p` : undefined;
  return <div ref={container} className={`player-settings ${audio ? 'settings-over-art' : ''}`} onKeyDown={keys}>
    <button ref={trigger} className={`icon-button${quality ? ' with-quality' : ''}`} title="Playback settings" aria-label="Playback settings"
      aria-description={quality && `Current video quality ${quality}`} aria-haspopup="menu" aria-expanded={!!menu} onClick={() => setMenu(value => value ? null : 'root')}>
      {quality && <span className="player-current-quality" aria-hidden="true">{quality}</span>}
      <Settings size={21} />
    </button>
    {menu && <div className="player-settings-menu" role="menu" aria-label="Playback settings" data-player-menu>
      {menu !== 'root' && <button className="settings-menu-back" role="menuitem" onClick={() => setMenu('root')}><ArrowLeft size={18} />{({ mode: 'Playback mode', speed: 'Playback speed', quality: 'Quality', subtitles: 'Subtitles' })[menu]}</button>}
      {menu === 'root' && <>
        <button role="menuitem" onClick={() => setMenu('mode')}><Headphones size={21} /><span>Playback mode</span><small>{audio ? 'Audio only' : 'Video'}</small><ChevronRight size={18} /></button>
        <button role="menuitem" onClick={() => setMenu('speed')}><Gauge size={21} /><span>Playback speed</span><small>{player.speed === 1 ? 'Normal' : `${player.speed}×`}</small><ChevronRight size={18} /></button>
        <button role="menuitem" disabled={audio || !player.qualities.length} onClick={() => setMenu('quality')}><SlidersHorizontal size={21} /><span>Quality</span><small>{audio ? 'Audio only' : `${player.quality}p`}</small><ChevronRight size={18} /></button>
        {!audio && <button role="menuitem" disabled={!hasVideoSource} onClick={() => setMenu('subtitles')}><Captions size={21} /><span>Subtitles</span><small>{player.subtitleTrackId ? 'On' : 'Off'}</small><ChevronRight size={18} /></button>}
      </>}
      {menu === 'mode' && (['video', 'audio'] as const).map(mode => <button role="menuitemradio" aria-checked={(audio ? 'audio' : 'video') === mode} key={mode} onClick={() => { onMode(mode); close(); }}><span className="menu-check">{(audio ? 'audio' : 'video') === mode && <Check size={17} />}</span>{mode === 'video' ? <Video size={18} /> : <Music2 size={18} />}<span>{mode === 'video' ? 'Video' : 'Audio only'}</span></button>)}
      {menu === 'speed' && [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(speed => <button role="menuitemradio" aria-checked={player.speed === speed} key={speed} onClick={() => { onAction('speed', speed); close(); }}><span className="menu-check">{player.speed === speed && <Check size={17} />}</span><span>{speed === 1 ? 'Normal' : `${speed}×`}</span></button>)}
      {menu === 'quality' && [...player.qualities].sort((a, b) => b - a).map(quality => <button role="menuitemradio" aria-checked={player.quality === quality} key={quality} onClick={() => { onAction('quality', quality); close(); }}><span className="menu-check">{player.quality === quality && <Check size={17} />}</span><span>{quality}p</span>{quality >= 1080 && <small>HD</small>}</button>)}
      {menu === 'subtitles' && !audio && <SubtitleOptions key={player.loadId} loadId={player.loadId} selected={player.subtitleTrackId ?? null} />}
    </div>}
  </div>;
}

interface ControlsProps {
  player: PlayerState; audio: boolean; compact?: boolean; visible?: boolean; variant?: 'surface' | 'accessible' | 'dock';
  fullscreen: boolean; theater: boolean; hasPrevious: boolean; hasNext: boolean;
  onAction: (action: PlayerAction, value?: number) => void; onMode: (mode: PlaybackMode) => void;
  onPrevious: () => void; onNext: () => void; onFullscreen: () => void; onTheater: () => void; onRetry?: () => void;
  onMinimize?: () => void;
  onMenuChange?: (open: boolean) => void; onDragging?: (active: boolean) => void;
}

function replayHeatmap(intervals: ReplayHeatmapInterval[], duration: number) {
  const vertices = ['0% 100%'];
  const vertex = (seconds: number, value: number) =>
    `${(seconds / duration * 100).toFixed(3)}% ${((1 - value) * 100).toFixed(2)}%`;
  let lastEnd = 0, lastValue = 0, peakTime = 0, peakValue = 0;
  for (const interval of intervals) {
    const start = Math.max(lastEnd, interval.startTime);
    const end = Math.min(duration, interval.endTime);
    if (end <= start) continue;
    const middle = (start + end) / 2;
    if (start > lastEnd + 0.01) {
      vertices.push(vertex(lastEnd, lastValue), vertex(lastEnd, 0), vertex(start, 0), vertex(start, interval.value));
    } else if (vertices.length === 1) {
      vertices.push(vertex(start, interval.value));
    }
    vertices.push(vertex(middle, interval.value));
    if (interval.value > peakValue) {
      peakTime = middle;
      peakValue = interval.value;
    }
    lastEnd = end;
    lastValue = interval.value;
  }
  if (peakValue === 0) return null;
  vertices.push(vertex(lastEnd, lastValue), vertex(lastEnd, 0), '100% 100%');
  return { clipPath: `polygon(${vertices.join(', ')})`, peakTime };
}

interface HeatmapProps { intervals: ReplayHeatmapInterval[]; duration: number; descriptionId: string }

const ReplayHeatmap = memo(function ReplayHeatmap({ intervals, duration, descriptionId }: HeatmapProps) {
  const heatmap = replayHeatmap(intervals, duration);
  if (!heatmap) return null;
  return <>
    <div className="seek-heatmap" aria-hidden="true" style={{ clipPath: heatmap.clipPath }} />
    <span className="sr-only" id={descriptionId}>Most replayed around {time(heatmap.peakTime)}</span>
  </>;
}, (previous, next) => previous.duration === next.duration && previous.descriptionId === next.descriptionId
  && previous.intervals.length === next.intervals.length
  // Native progress events deserialize fresh copies of the same metadata.
  && previous.intervals.every((point, i) => {
    const nextPoint = next.intervals[i];
    return point.startTime === nextPoint.startTime && point.endTime === nextPoint.endTime && point.value === nextPoint.value;
  }));

function usePlaybackPosition(player: PlayerState, active: boolean) {
  const track = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null), dragging = useRef(false);
  const anchor = useRef({ position: player.position, time: performance.now(), player });
  const [position, setPosition] = useState(player.position);
  const displayedSecond = useRef(Math.floor(player.position));
  const draw = (value: number) => {
    const input = slider.current;
    track.current?.style.setProperty('--range-progress', `${anchor.current.player.duration ? Math.min(100, value / anchor.current.player.duration * 100) : 0}%`);
    const second = Math.floor(value);
    if (second !== displayedSecond.current) {
      displayedSecond.current = second;
      setPosition(value);
    }
    if (input && !dragging.current) {
      const stepValue = Math.round(value * 10) / 10;
      if (input.valueAsNumber !== stepValue) input.valueAsNumber = stepValue;
    }
  };
  useEffect(() => {
    dragging.current = false;
    slider.current?.removeAttribute('data-seeking');
  }, [player.loadId]);
  useEffect(() => {
    anchor.current = { position: player.position, time: performance.now(), player };
    if (active && !dragging.current) draw(player.position);
  }, [active, player.position, player.duration, player.status, player.speed, player.loadId]);
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
  return { track, slider, dragging, position, preview: draw, commit: (value: number) => { anchor.current = { position: value, time: performance.now(), player }; draw(value); } };
}

export function VolumeControl({ player, onAction, compact = false }: { player: PlayerState; onAction: ControlsProps['onAction']; compact?: boolean }) {
  return <div className="volume-control"><IconButton label={player.muted ? 'Unmute (M)' : 'Mute (M)'} onClick={() => onAction('mute', player.muted ? 0 : 1)}>{player.muted || !player.volume ? <VolumeX size={21} /> : <Volume2 size={21} />}</IconButton>{!compact && <input data-player-range type="range" min="0" max="100" value={player.volume} onChange={event => onAction('volume', Number(event.target.value))} aria-label="Volume" aria-valuetext={`${Math.round(player.volume)}%${player.muted ? ', muted' : ''}`} />}</div>;
}

export const PlayerControls = memo(function PlayerControls({ player, audio, compact = false, visible = true, variant = 'surface', fullscreen, theater, hasPrevious, hasNext, onAction, onMode, onPrevious, onNext, onFullscreen, onTheater, onMinimize, onRetry, onMenuChange, onDragging }: ControlsProps) {
  const seekId = useId(), progress = usePlaybackPosition(player, visible);
  const pointerLoad = useRef(player.loadId), cancelledSeek = useRef(false);
  const busy = ['resolving', 'preparing'].includes(player.status), playing = ['playing', 'buffering'].includes(player.status);
  const seekable = !busy && Number.isFinite(player.duration) && player.duration > 0;
  const intervals = player.video?.heatmap;
  const showHeatmap = seekable
    && intervals?.some(point => point.value > 0 && point.startTime < player.duration && point.endTime > 0);
  const heatmapId = showHeatmap ? `${seekId}-heatmap` : undefined;
  useEffect(() => { if (pointerLoad.current !== player.loadId) cancelledSeek.current = true; onDragging?.(false); }, [player.loadId]);
  function finishSeek(commit: boolean) {
    if (!progress.dragging.current) return;
    progress.dragging.current = false;
    progress.slider.current?.removeAttribute('data-seeking');
    onDragging?.(false);
    if (commit && !cancelledSeek.current && pointerLoad.current === player.loadId && progress.slider.current) {
      const value = Number(progress.slider.current.value); progress.commit(value); onAction('seek', value);
    } else progress.commit(player.position);
  }
  const chapter = chapterAt(player.video?.chapters, progress.position, player.duration);
  const seek = <SeekTimeline player={player} showThumbnail={!audio && variant !== 'dock'} enabled={seekable && player.status !== 'failed'} visible={visible} dragging={progress.dragging} trackRef={progress.track}>
    {intervals && heatmapId && <ReplayHeatmap intervals={intervals} duration={player.duration} descriptionId={heatmapId} />}
    <label className="sr-only" htmlFor={seekId}>Playback position</label><input ref={progress.slider} data-player-range id={seekId} className="seek-slider" type="range" min="0" max={Math.max(1, player.duration)} step="0.1" defaultValue={player.position}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return;
      cancelledSeek.current = false;
      pointerLoad.current = player.loadId;
      progress.dragging.current = true;
      event.currentTarget.setAttribute('data-seeking', '');
      onDragging?.(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerUp={() => finishSeek(true)} onPointerCancel={() => { cancelledSeek.current = true; finishSeek(false); }} onLostPointerCapture={() => { if (progress.dragging.current) { cancelledSeek.current = true; finishSeek(false); } }} onKeyDown={() => { cancelledSeek.current = false; }}
    onChange={event => { if (cancelledSeek.current) return; const value = Number(event.target.value); progress.preview(value); if (!progress.dragging.current) { progress.commit(value); onAction('seek', value); } }}
    disabled={!seekable} aria-valuetext={`${time(progress.position)} of ${time(player.duration)}${chapter ? `, ${chapter.title}` : ''}`} aria-describedby={heatmapId} />
  </SeekTimeline>;
  const transport = <><IconButton label="Previous video" disabled={!hasPrevious} onClick={onPrevious}><SkipBack size={20} fill="currentColor" /></IconButton><IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={busy} onClick={() => player.status === 'failed' && onRetry ? onRetry() : onAction('toggle')} className={variant === 'dock' ? 'bottom-play-button' : 'play-control'}>{playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}</IconButton><IconButton label="Next video" disabled={!hasNext} onClick={onNext}><SkipForward size={20} fill="currentColor" /></IconButton></>;
  if (variant === 'dock') return <div className="bottom-player-transport shared-player-controls" role="group" aria-label="Playback controls"><div className="bottom-transport-buttons">{transport}</div><div className="bottom-player-progress"><span>{time(progress.position)}</span>{seek}<span>{time(player.duration)}</span></div></div>;
  return <div className={`player-controls html-player-controls shared-player-controls ${compact ? 'compact-controls' : ''} ${variant === 'surface' ? 'surface-player-controls' : ''}`} data-player-interactive>
    {seek}<div className="control-row"><div className="control-group">{transport}<VolumeControl player={player} onAction={onAction} compact={compact} /><span className="player-time">{time(progress.position)}<span> / {time(player.duration)}</span></span></div>
      <div className="control-group right-controls">
        <PlayerSettings player={player} audio={audio} visible={visible} onAction={onAction} onMode={onMode} onMenuChange={onMenuChange} />
        {!compact && <>
          {onMinimize && <IconButton label="Minimize player" onClick={onMinimize}><PictureInPicture2 size={21} /></IconButton>}
          <IconButton label={theater ? 'Exit theater mode' : 'Theater mode'} onClick={onTheater}><RectangleHorizontal size={21} /></IconButton>
          <IconButton label={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} onClick={onFullscreen}>{fullscreen ? <Minimize size={21} /> : <Maximize size={21} />}</IconButton>
        </>}
      </div>
    </div>
  </div>;
});
