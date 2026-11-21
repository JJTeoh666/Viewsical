import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode, Ref } from 'react';
import { time } from './format';
import type { PlayerState, ReplayHeatmapInterval, Storyboard, VideoChapter } from './types';

export function chapterAt(chapters: VideoChapter[] | undefined, seconds: number, duration: number) {
  return chapters?.find(chapter => seconds >= chapter.startTime
    && (seconds < chapter.endTime || (seconds === duration && seconds === chapter.endTime)));
}

const ChapterSegments = memo(function ChapterSegments({ chapters, duration, position }: {
  chapters: VideoChapter[]; duration: number; position: number | null;
}) {
  const boundaries = useMemo(() => {
    const times = chapters.flatMap(chapter => [chapter.startTime, chapter.endTime])
      .filter(seconds => seconds > 0 && seconds < duration);
    return [0, ...[...new Set(times)].sort((a, b) => a - b), duration];
  }, [chapters, duration]);
  return <div className="seek-rail" aria-hidden="true">
    {boundaries.slice(1).map((end, index) => {
      const start = boundaries[index];
      const active = position !== null && position >= start
        && (position < end || (position === duration && end === duration));
      return <span className={`seek-chapter-segment${active ? ' is-active' : ''}`} key={start} style={{
        '--chapter-start': `${start / duration * 100}%`,
        '--chapter-span': (end - start) / duration,
        '--seek-segment-offset': index === 0 ? '0px' : `calc(${start / duration * 100}cqw + var(--seek-chapter-gap) / 2)`,
        left: 'var(--seek-segment-offset)',
        right: end === duration ? 0 : `calc(${(duration - end) / duration * 100}% + var(--seek-chapter-gap) / 2)`,
      } as CSSProperties} />;
    })}
  </div>;
}, (a, b) => a.duration === b.duration && a.position === b.position && a.chapters.length === b.chapters.length && a.chapters.every((chapter, i) =>
  chapter.startTime === b.chapters[i].startTime && chapter.endTime === b.chapters[i].endTime));

function PreviewImage({ url, board, tile }: { url: string; board: Storyboard; tile: number }) {
  const [requested, setRequested] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    // Skip sheets the pointer crosses briefly while scrubbing.
    const timer = window.setTimeout(() => setRequested(true), 65);
    return () => window.clearTimeout(timer);
  }, []);
  if (!requested) return null;
  return <div className="seek-preview-image" hidden={!size} style={{
    aspectRatio: `${board.width} / ${board.height}`, '--seek-frame-aspect': board.width / board.height,
  } as CSSProperties}>
    <img src={url} alt="" draggable={false} decoding="async" referrerPolicy="no-referrer"
      onLoad={({ currentTarget: image }) => setSize({ width: image.naturalWidth, height: image.naturalHeight })}
      onError={() => setSize(null)}
      style={{ width: `${(size?.width ?? board.width) / board.width * 100}%`,
        height: `${(size?.height ?? board.height) / board.height * 100}%`,
        left: `${-(tile % board.columns) * 100}%`, top: `${-Math.floor(tile / board.columns) * 100}%` }} />
  </div>;
}

function TimelinePreview({ player, position, audio }: { player: PlayerState; position: number; audio: boolean }) {
  const { duration, video } = player;
  const storyboard = audio ? undefined : player.storyboard;
  const fraction = position / duration;
  const chapter = chapterAt(video?.chapters, position, duration);
  const peak = video?.heatmap?.reduce<ReplayHeatmapInterval | undefined>(
    (best, point) => point.startTime < duration && point.value > (best?.value ?? 0) ? point : best, undefined);
  const mostReplayed = peak && position >= peak.startTime && position < peak.endTime;
  const frame = storyboard ? Math.min(storyboard.frameCount - 1, Math.floor(position / storyboard.frameDuration)) : 0;
  const tiles = storyboard ? storyboard.rows * storyboard.columns : 1;
  const sheet = storyboard?.urlTemplate.replaceAll('$M', String(Math.floor(frame / tiles)));

  return <div className="seek-preview-layer" aria-hidden="true" style={{ '--seek-preview-x': `${fraction * 100}%` } as CSSProperties}>
    <div className={sheet ? 'seek-preview with-storyboard' : 'seek-preview'}>
      {sheet && storyboard && <PreviewImage key={sheet} url={sheet} board={storyboard} tile={frame % tiles} />}
      <div className="seek-preview-caption">
        <span className="seek-preview-time">{time(position)}</span>
        {chapter && <span className="seek-preview-chapter">{chapter.title}</span>}
        {mostReplayed && <span className="seek-preview-peak">Most replayed</span>}
      </div>
    </div>
  </div>;
}

export function SeekTimeline({ player, audio, enabled, visible, dragging, trackRef, children }: {
  player: PlayerState; audio: boolean; enabled: boolean; visible: boolean; dragging: { current: boolean };
  trackRef: Ref<HTMLDivElement>; children: ReactNode;
}) {
  const [hover, setHover] = useState<{ loadId: number; position: number } | null>(null);
  const frame = useRef(0);
  const next = useRef(0);
  const chapters = player.video?.chapters;

  function hide() {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    setHover(null);
  }
  useEffect(hide, [player.loadId, enabled, visible]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function show(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || !visible || (event.pointerType === 'touch' && !dragging.current)) return;
    const track = event.currentTarget;
    next.current = event.clientX;
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const rect = track.getBoundingClientRect();
      const inset = Number.parseFloat(getComputedStyle(track).getPropertyValue('--seek-thumb-size')) / 2;
      const span = rect.width - inset * 2;
      if (!(span > 0)) return;
      const fraction = Math.min(1, Math.max(0, (next.current - rect.left - inset) / span));
      setHover({ loadId: player.loadId, position: fraction * player.duration });
    });
  }

  const position = enabled && visible && hover?.loadId === player.loadId ? Math.min(hover.position, player.duration) : null;
  const hasChapters = enabled && !!chapters?.length;
  return <div ref={trackRef} className="seek-track" data-player-timeline
    style={{
      '--range-progress': `${player.duration > 0 ? Math.min(100, player.position / player.duration * 100) : 0}%`,
      '--seek-hover-offset': position === null ? '0px' : `${position / player.duration * 100}cqw`,
    } as CSSProperties}
    onPointerEnter={show} onPointerMove={show} onPointerDown={show}
    onPointerLeave={hide} onPointerCancel={hide} onPointerUp={event => { if (event.pointerType === 'touch') hide(); }}>
    {hasChapters
      ? <ChapterSegments chapters={chapters} duration={player.duration} position={position} />
      : <div className="seek-rail" aria-hidden="true"><span className="seek-continuous-rail" /></div>}
    {children}
    {position !== null && <TimelinePreview player={player} position={position} audio={audio} />}
  </div>;
}
