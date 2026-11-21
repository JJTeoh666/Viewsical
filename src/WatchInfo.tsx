import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownToLine, ListPlus, Share2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api } from './api';
import { ChannelSubscribe } from './ChannelSubscribe';
import { errorMessage, views } from './format';
import { SaveVideoDialog } from './SaveVideoDialog';
import { ShareVideoDialog } from './ShareVideoDialog';
import type { MediaItem, SessionSnapshot, VideoRating, WatchDetails } from './types';
import './watch-actions.css';

export type OpenVideoChannel = (item: MediaItem, avatar?: string | null) => void;

const compactCount = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });

function VideoDescription({ description, count, date }: {
  description: string | null;
  count: number | null;
  date: string | null | undefined;
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
  const preview = shortened ? `${endsMidWord ? excerpt.slice(0, lastSpace) : excerpt}…` : compact;
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
    {text && <p id={bodyId}>{expanded ? text : preview}</p>}
    {canExpand && <button type="button" className="description-toggle" aria-expanded={expanded} aria-controls={bodyId}
      onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show more'}</button>}
  </section>;
}

export function WatchInfo({ video, session, position, resolving, onOpenChannel, onSubscriptionChange, onSaved, onDownload }: {
  video: MediaItem;
  session: SessionSnapshot;
  position: number;
  resolving: boolean;
  onOpenChannel: OpenVideoChannel;
  onSubscriptionChange: () => void;
  onSaved: (title: string, youtube: boolean) => void;
  onDownload: (item: MediaItem) => void;
}) {
  const [details, setDetails] = useState<WatchDetails>();
  const [rating, setRating] = useState<VideoRating | null>(null);
  const [ratingPending, setRatingPending] = useState(false);
  const [ratingError, setRatingError] = useState('');
  const [sharePosition, setSharePosition] = useState<number | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
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

  return <div className="video-details">
    <h1>{video.title}</h1>
    <div className="watch-info-row">
      <div className="watch-channel">
        <button type="button" className="channel-info" aria-label={`Open ${channel} channel`}
          onClick={() => onOpenChannel({ ...video, channel, channelId }, details?.channelAvatar)}>
          <span className="channel-avatar" aria-hidden="true">{Array.from(channel)[0].toUpperCase()}
            {details?.channelAvatar && <img src={details.channelAvatar} alt="" referrerPolicy="no-referrer"
              onError={event => { event.currentTarget.hidden = true; }} />}
          </span>
          <span className="watch-channel-copy"><strong>{channel}</strong>
            {subscribers != null && <small title={subscribers.toLocaleString()}>{compactCount.format(subscribers)} {subscribers === 1 ? 'subscriber' : 'subscribers'}</small>}
          </span>
        </button>
        <ChannelSubscribe key={channelId} channelId={channelId} title={channel} session={session} onChanged={onSubscriptionChange} />
      </div>
      <div className="watch-actions">
        <div className="watch-ratings" role="group" aria-label="Video rating" title={ratingTitle}>
          <button type="button" aria-label="Like" aria-pressed={rating === 'like'} title={connected ? 'Like' : undefined}
            disabled={!connected || ratingPending} onClick={() => void rate('like')}><ThumbsUp size={17} />{likeLabel && <span aria-hidden="true">{likeLabel}</span>}</button>
          <button type="button" aria-label="Dislike" aria-pressed={rating === 'dislike'} title={connected ? 'Dislike' : undefined}
            disabled={!connected || ratingPending} onClick={() => void rate('dislike')}><ThumbsDown size={17} /></button>
        </div>
        <button type="button" className="button secondary" onClick={() => setSharePosition(position)}><Share2 size={17} />Share</button>
        <button type="button" className="button secondary" onClick={() => setSaveOpen(true)}><ListPlus size={18} />Add to playlist</button>
        <button type="button" className="button secondary watch-download" aria-label="Download" title="Download"
          onClick={() => onDownload(video)}><ArrowDownToLine size={19} /></button>
      </div>
    </div>
    {ratingError && <p className="watch-rating-error" role="alert">{ratingError}</p>}
    <VideoDescription description={details?.description ?? video.description} count={details?.viewCount ?? video.viewCount} date={details?.uploadDate} />
    {sharePosition !== null && <ShareVideoDialog videoId={video.id} position={sharePosition} onClose={() => setSharePosition(null)} />}
    {saveOpen && <SaveVideoDialog video={video} session={session} onClose={() => setSaveOpen(false)}
      onSaved={(title, youtube) => { setSaveOpen(false); onSaved(title, youtube); }} />}
  </div>;
}
