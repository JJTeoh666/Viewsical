import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowDownToLine, Ellipsis, ListPlus, Share2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api } from './api';
import { ChannelSubscribe } from './ChannelSubscribe';
import { errorMessage, views } from './format';
import { SaveVideoDialog } from './SaveVideoDialog';
import { ShareVideoDialog } from './ShareVideoDialog';
import { TimestampText } from './TimestampText';
import type { MediaItem, SessionSnapshot, VideoRating, WatchDetails } from './types';
import './watch-actions.css';

export type OpenVideoChannel = (item: MediaItem, avatar?: string | null) => void;

const compactCount = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });

function WatchActionMenu({ onSave, onDownload }: { onSave: () => void; onDownload: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  function close() {
    trigger.current?.focus();
    setOpen(false);
  }

  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll('button'));
    const index = items.findIndex(item => item === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  return <div className="watch-more" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="button secondary watch-more-trigger" aria-label="More video actions"
      title="More video actions" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        if (open) menu.current?.querySelector('button')?.focus();
        else setOpen(true);
      }}><Ellipsis size={20} aria-hidden="true" /></button>
    {open && <div id={id} ref={menu} className="watch-more-menu" role="menu" aria-label="More video actions" onKeyDown={menuKeys}>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { close(); onSave(); }}><ListPlus size={18} aria-hidden="true" />Add to playlist</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { close(); onDownload(); }}><ArrowDownToLine size={18} aria-hidden="true" />Download</button>
    </div>}
  </div>;
}

function VideoDescription({ description, count, date, duration, onSeek }: {
  description: string | null;
  count: number | null;
  date: string | null | undefined;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const text = description?.trim();
  const compact = text?.replace(/\s+/g, ' ') ?? '';
  const characters = Array.from(compact);
  const shortened = characters.length > 140;
  const canExpand = shortened || Boolean(text && text !== compact);
  const excerpt = characters.slice(0, 140).join('').trimEnd();
  const lastSpace = excerpt.lastIndexOf(' ');
  const endsMidWord = shortened && characters[139] !== ' ' && characters[140] !== ' ' && lastSpace > 105;
  const previewLength = shortened ? (endsMidWord ? lastSpace : excerpt.length) : compact.length;
  const upload = date ? new Date(`${date}T00:00:00Z`) : null;
  const formatted = upload && Number.isFinite(upload.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(upload)
    : '';
  const viewLabel = count === 1 ? '1 view' : views(count);
  if (!viewLabel && !formatted && !text) return null;

  return <section className="description-box" aria-label="Video description">
    {(viewLabel || formatted) && <div className="watch-facts">
      {viewLabel && <span title={count == null ? undefined : `${count.toLocaleString()} ${count === 1 ? 'view' : 'views'}`}>{viewLabel}</span>}
      {formatted && date && <time dateTime={date}>{formatted}</time>}
    </div>}
    {text && <p id={bodyId}><TimestampText text={expanded ? text : compact} duration={duration} onSeek={onSeek}
      visibleLength={expanded ? undefined : previewLength} />{!expanded && shortened && '…'}</p>}
    {canExpand && <button type="button" className="description-toggle" aria-expanded={expanded} aria-controls={bodyId}
      onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show more'}</button>}
  </section>;
}

export function WatchInfo({ video, session, position, resolving, duration, onSeek, onOpenChannel, onSubscriptionChange, onSignIn, onSaved, onDownload }: {
  video: MediaItem;
  session: SessionSnapshot;
  position: number;
  resolving: boolean;
  duration: number;
  onSeek: (seconds: number) => void;
  onOpenChannel: OpenVideoChannel;
  onSubscriptionChange: () => void;
  onSignIn: () => void;
  onSaved: (title: string, youtube: boolean) => void;
  onDownload: (item: MediaItem) => void;
}) {
  const [details, setDetails] = useState<WatchDetails>();
  const [rating, setRating] = useState<VideoRating | null>(null);
  const [ratingPending, setRatingPending] = useState(false);
  const [ratingError, setRatingError] = useState('');
  const [sharePosition, setSharePosition] = useState<number | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [compactActions, setCompactActions] = useState(false);
  const infoRow = useRef<HTMLDivElement>(null);
  const creator = useRef<HTMLButtonElement>(null);
  const primaryActions = useRef<HTMLDivElement>(null);
  const directActions = useRef<HTMLDivElement>(null);
  const ratingUpdated = useRef(false);
  const connected = session.status === 'connected';

  useEffect(() => {
    // Let playback resolution populate the metadata cache before looking it up.
    if (resolving || details || session.status === 'restoring') return;
    let active = true;
    void api.watchDetails(video.id, session.generation).then(result => {
      if (!active) return;
      setDetails(result);
      if (!ratingUpdated.current) setRating(result.rating);
    }).catch(() => {});
    return () => { active = false; };
  }, [details, resolving, video.id, session.generation, session.status]);

  async function rate(choice: VideoRating) {
    if (!connected || ratingPending) return;
    const next = rating === choice ? 'none' : choice;
    setRatingPending(true);
    setRatingError('');
    try {
      await api.rateVideo(video.id, session.generation, next);
      ratingUpdated.current = true;
      setRating(next);
    } catch (error) {
      setRatingError(errorMessage(error));
    } finally {
      setRatingPending(false);
    }
  }

  const likeCount = details?.likeCount;
  const displayedLikes = likeCount == null ? null : Math.max(0, likeCount + Number(rating === 'like') - Number(details?.rating === 'like'));
  const likeLabel = displayedLikes == null ? '' : new Intl.NumberFormat(undefined, { notation: 'compact' }).format(displayedLikes);
  const channel = details?.channelName || video.channel || 'YouTube channel';
  const channelId = details?.channelId || video.channelId || undefined;
  const subscribers = details?.subscriberCount;
  const ratingTitle = connected ? undefined : 'Sign in to like or dislike videos';

  useLayoutEffect(() => {
    const row = infoRow.current;
    const info = creator.current;
    const primary = primaryActions.current;
    const direct = directActions.current;
    const avatar = info?.querySelector('.channel-avatar');
    const copy = info?.querySelector('.watch-channel-copy');
    const channelGroup = info?.parentElement;
    const subscription = channelGroup?.querySelector('.channel-subscription');
    const actions = primary?.parentElement;
    if (!row || !info || !primary || !direct || !avatar || !copy || !channelGroup || !subscription || !actions) return;

    const measure = () => {
      // The direct buttons remain measurable while hidden so they can return when space opens up.
      const copyWidth = Math.max(...Array.from(copy.children, child => child.scrollWidth));
      const creatorWidth = avatar.getBoundingClientRect().width + parseFloat(getComputedStyle(info).columnGap) + copyWidth;
      const required = creatorWidth + subscription.getBoundingClientRect().width
        + primary.getBoundingClientRect().width + direct.getBoundingClientRect().width
        + parseFloat(getComputedStyle(row).columnGap) + parseFloat(getComputedStyle(channelGroup).columnGap)
        + parseFloat(getComputedStyle(actions).columnGap);
      setCompactActions(required > row.getBoundingClientRect().width);
    };
    const observer = new ResizeObserver(measure);
    for (const element of [row, avatar, copy, subscription, primary, direct]) observer.observe(element);
    document.fonts.addEventListener('loadingdone', measure);
    measure();
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [channel, channelId, subscribers]);

  return <div className="video-details">
    <h1>{video.title}</h1>
    <div ref={infoRow} className="watch-info-row" data-compact-actions={compactActions || undefined}>
      <div className="watch-channel">
        <button ref={creator} type="button" className="channel-info" title={channel} aria-label={`Open ${channel} channel`}
          onClick={() => onOpenChannel({ ...video, channel, channelId }, details?.channelAvatar)}>
          <span className="channel-avatar" aria-hidden="true">{Array.from(channel)[0].toUpperCase()}
            {details?.channelAvatar && <img src={details.channelAvatar} alt="" referrerPolicy="no-referrer"
              onError={event => { event.currentTarget.hidden = true; }} />}
          </span>
          <span className="watch-channel-copy"><strong>{channel}</strong>
            {subscribers != null && <small title={subscribers.toLocaleString()}>{compactCount.format(subscribers)} {subscribers === 1 ? 'subscriber' : 'subscribers'}</small>}
          </span>
        </button>
        <ChannelSubscribe key={channelId} channelId={channelId} videoId={video.id} title={channel}
          session={session} onChanged={onSubscriptionChange} onSignIn={onSignIn} />
      </div>
      <div className="watch-actions">
        <div ref={primaryActions} className="watch-action-group">
          <div className="watch-ratings" role="group" aria-label="Video rating" title={ratingTitle}>
            <button type="button" aria-label="Like" aria-pressed={rating === 'like'} title={connected ? 'Like' : undefined}
              disabled={!connected || ratingPending} onClick={() => void rate('like')}><ThumbsUp size={17} />{likeLabel && <span aria-hidden="true">{likeLabel}</span>}</button>
            <button type="button" aria-label="Dislike" aria-pressed={rating === 'dislike'} title={connected ? 'Dislike' : undefined}
              disabled={!connected || ratingPending} onClick={() => void rate('dislike')}><ThumbsDown size={17} /></button>
          </div>
          <button type="button" className="button secondary" onClick={() => setSharePosition(position)}><Share2 size={17} />Share</button>
        </div>
        <div ref={directActions} className="watch-action-group watch-action-direct" inert={compactActions}>
          <button type="button" className="button secondary" onClick={() => setSaveOpen(true)}><ListPlus size={18} />Add to playlist</button>
          <button type="button" className="button secondary watch-download" aria-label="Download" title="Download"
            onClick={() => onDownload(video)}><ArrowDownToLine size={19} /></button>
        </div>
        {compactActions && <WatchActionMenu onSave={() => setSaveOpen(true)} onDownload={() => onDownload(video)} />}
      </div>
    </div>
    {ratingError && <p className="watch-rating-error" role="alert">{ratingError}</p>}
    <VideoDescription description={details?.description ?? video.description} count={details?.viewCount ?? video.viewCount}
      date={details?.uploadDate} duration={duration} onSeek={onSeek} />
    {sharePosition !== null && <ShareVideoDialog videoId={video.id} position={sharePosition} onClose={() => setSharePosition(null)} />}
    {saveOpen && <SaveVideoDialog video={video} session={session} onClose={() => setSaveOpen(false)}
      onSaved={(title, youtube) => { setSaveOpen(false); onSaved(title, youtube); }} />}
  </div>;
}
