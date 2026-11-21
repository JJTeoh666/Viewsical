import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertCircle, Check, ChevronDown, Clock3, Languages, ListFilter, LoaderCircle, MessageSquare, MessageSquareOff, Pin, RefreshCw, ThumbsUp } from 'lucide-react';
import { api, isDesktop } from './api';
import { COMMENT_LIMIT, CommentCache, commentKey } from './commentCache';
import { commentTimestamps } from './commentTimestamps';
import { errorMessage } from './format';
import { IconButton } from './ui';
import type { CommentPage, CommentSort, VideoComment } from './types';
import './comments-sort.css';

const commentSortOptions = [
  { value: 'top', label: 'Top comments', description: 'Popular conversations', icon: ListFilter },
  { value: 'newest', label: 'Newest first', description: 'Most recent comments', icon: Clock3 },
] as const;

function CommentSortMenu({ sort, disabled, onSort }: { sort: CommentSort; disabled?: boolean; onSort: (sort: CommentSort) => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingFocus = useRef<number | null>(null);
  const menuId = useId();
  const selected = commentSortOptions.find(option => option.value === sort) ?? commentSortOptions[0];
  useEffect(() => {
    if (!open) return;
    const items = container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    const target = openingFocus.current == null ? container.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') : items?.[openingFocus.current];
    openingFocus.current = null;
    target?.focus();
    const dismiss = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  function close() { setOpen(false); trigger.current?.focus(); }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab' && open) { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!open) { openingFocus.current = event.key === 'End' || event.key === 'ArrowUp' ? commentSortOptions.length - 1 : 0; setOpen(true); return; }
    const items = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  return <div className="comment-sort-control" ref={container} onKeyDown={keys} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button ref={trigger} type="button" className="comment-sort-trigger" aria-label={`Sort comments: ${selected.label}`} aria-haspopup="menu" aria-controls={open ? menuId : undefined} aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}><ListFilter size={17} aria-hidden="true" /><span>{selected.label}</span><ChevronDown size={16} className={open ? 'sort-chevron-open' : ''} aria-hidden="true" /></button>
    {open && <div id={menuId} className="comment-sort-menu" role="menu" aria-label="Sort comments">{commentSortOptions.map(({ value, label, description, icon: Icon }) => <button key={value} type="button" role="menuitemradio" aria-checked={sort === value} onClick={() => { onSort(value); close(); }}><Icon size={18} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span><span className="comment-sort-check" aria-hidden="true">{sort === value && <Check size={17} />}</span></button>)}</div>}
  </div>;
}

type CommentTranslation = { source: string } & (
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; text: string; show: boolean }
);

function CommentText({ text, duration, onSeek }: { text: string; duration: number; onSeek: (seconds: number) => void }) {
  const timestamps = commentTimestamps(text, duration);
  let start = 0;
  const content = timestamps.map(({ index, label, seconds }) => {
    const precedingText = text.slice(start, index);
    start = index + label.length;
    return <span key={index}>{precedingText}<button type="button" className="comment-timestamp" dir="ltr" aria-label={`Jump to ${label}`} onClick={() => onSeek(seconds)}>{label}</button></span>;
  });
  return <>{content}{text.slice(start)}</>;
}

type CommentRowContext = {
  generation: number; duration: number; onSeek: (seconds: number) => void;
  onOpenAuthor: (channelId: string, name: string, thumbnail: string | null) => void;
};

function CommentReplies({ comment, videoId, sort, context }: {
  comment: VideoComment; videoId: string; sort: CommentSort; context: CommentRowContext;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<CommentPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; cursor: string | null }>();
  const request = useRef<string | null>(null);

  useEffect(() => () => {
    if (request.current) void api.cancelComments(request.current).catch(() => {});
    request.current = null;
  }, []);

  async function load(cursor: string | null) {
    if (request.current) return;
    const requestId = crypto.randomUUID();
    request.current = requestId;
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.commentReplies(videoId, comment.id, cursor, sort, requestId);
      if (request.current !== requestId) return;
      if (result.videoId !== videoId || result.parentId !== comment.id || result.sort !== sort) {
        throw new Error('These replies changed. Try again.');
      }
      const previous = cursor ? page?.items ?? [] : [];
      const ids = new Set(previous.map(item => item.id));
      const items = [...previous];
      for (const item of result.items) {
        if (ids.has(item.id)) continue;
        ids.add(item.id);
        items.push(item);
      }
      setPage({ ...result, items });
    } catch (failure) {
      if (request.current === requestId) {
        const changed = (failure as { code?: string } | null)?.code === 'comments_changed';
        setError({ message: errorMessage(failure), cursor: changed ? null : cursor });
      }
    } finally {
      if (request.current === requestId) {
        request.current = null;
        setLoading(false);
      }
    }
  }

  const count = comment.replyCount;
  const label = count ? `${count.toLocaleString()} ${count === 1 ? 'reply' : 'replies'}` : 'Show replies';
  return <div className="comment-thread">
    <button type="button" className="comment-replies-toggle" aria-expanded={open} aria-controls={id} onClick={() => {
      setOpen(!open);
      if (!open && !page && !error) void load(null);
    }}><ChevronDown size={16} aria-hidden="true" />{open ? 'Hide replies' : label}</button>
    <div id={id} className="comment-replies" hidden={!open}>
      {open && page?.items.map(reply => <CommentRow key={reply.id} comment={reply} {...context} />)}
      {loading && <p className="comment-replies-status" role="status">Loading replies…</p>}
      {error && <div className="comment-replies-status" role="alert">{error.message} <button className="text-link" onClick={() => void load(error.cursor)}>Retry</button></div>}
      {!loading && !error && page?.items.length === 0 && <p className="comment-replies-status">No replies to show.</p>}
      {!error && page?.nextCursor && !page.limited && <button type="button" className="text-link comment-more-replies"
        disabled={loading} onClick={() => void load(page.nextCursor)}>More replies</button>}
      {page?.limited && <p className="comment-replies-status">Showing the first {COMMENT_LIMIT} replies.</p>}
    </div>
  </div>;
}

function CommentRow({ comment, replyScope, ...context }: CommentRowContext & {
  comment: VideoComment; replyScope?: { videoId: string; sort: CommentSort };
}) {
  const { generation, duration, onSeek, onOpenAuthor } = context;
  const [expanded, setExpanded] = useState(false);
  const [translation, setTranslation] = useState<CommentTranslation | null>(null);
  const request = useRef(0);
  const result = translation?.source === comment.text ? translation : null;
  const translated = result?.status === 'ready' && result.text.trim() !== comment.text.trim();
  const showTranslation = result?.status === 'ready' && translated && result.show;
  const text = showTranslation ? result.text : comment.text;
  const long = text.length > 350 || text.split('\n').length > 4;

  async function translate() {
    if (result?.status === 'ready') {
      setTranslation({ ...result, show: !result.show });
      return;
    }
    const source = comment.text;
    const id = ++request.current;
    setTranslation({ source, status: 'loading' });
    try {
      const text = await api.translateComment(generation, source);
      if (request.current === id) setTranslation({ source, status: 'ready', text, show: true });
    } catch (error) {
      if (request.current === id && (error as { code?: string } | null)?.code !== 'cancelled') {
        setTranslation({ source, status: 'error', message: errorMessage(error) });
      }
    }
  }

  const author = comment.author || 'YouTube user';
  const channelId = comment.authorChannelId;
  const openProfile = channelId ? () => onOpenAuthor(channelId, author, comment.authorThumbnail) : undefined;
  const avatar = <>{Array.from(author)[0].toUpperCase()}{comment.authorThumbnail && <img src={comment.authorThumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />}</>;

  return <article className="comment-row">
    {openProfile
      ? <button type="button" className="comment-avatar" tabIndex={-1} aria-label={`Open ${author}'s profile`} onClick={openProfile}>{avatar}</button>
      : <span className="comment-avatar" aria-hidden="true">{avatar}</span>}
    <div className="comment-body">{comment.isPinned && <div className="comment-pinned"><Pin size={12} />Pinned</div>}<div className="comment-author">
      {openProfile ? <button type="button" className="comment-author-link" onClick={openProfile}>{author}</button> : <strong>{author}</strong>}
      {comment.authorIsUploader && <span className="comment-creator">Creator</span>}{comment.published && <time>{comment.published}</time>}</div>
      <p className={`comment-text ${long && !expanded ? 'comment-collapsed' : ''}`} dir="auto" lang={showTranslation ? 'en' : undefined}><CommentText text={text} duration={duration} onSeek={onSeek} /></p>
      <div className="comment-text-actions">
        {long && <button type="button" className="comment-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Read more'}</button>}
        {result?.status === 'ready' && !translated
          ? <span className="comment-translation-status" role="status">No translation needed</span>
          : <button type="button" className="comment-translate" disabled={result?.status === 'loading'} onClick={() => void translate()}>
            {result?.status === 'loading' ? <LoaderCircle aria-hidden="true" size={14} className="spin" /> : <Languages aria-hidden="true" size={14} />}
            {result?.status === 'loading' ? 'Translating…' : showTranslation ? 'Show original' : result?.status === 'error' ? 'Retry translation' : 'Translate to English'}
          </button>}
      </div>
      {result?.status === 'error' && <p className="comment-translation-error" role="alert">{result.message}</p>}
      {comment.likeCount != null && <div className="comment-counts"><span aria-label={`${comment.likeCount.toLocaleString()} likes`}><ThumbsUp size={14} />{comment.likeCount.toLocaleString()}</span></div>}
      {replyScope && (comment.hasReplies || (comment.replyCount ?? 0) > 0) && <CommentReplies comment={comment} context={context} {...replyScope} />}
    </div>
  </article>;
}

export function CommentsPanel({ videoId, generation, cache, sort, onSort, duration, onSeek, onOpenAuthor }: {
  videoId: string; generation: number; cache: CommentCache; sort: CommentSort;
  onSort: (sort: CommentSort) => void; duration: number; onSeek: (seconds: number) => void;
  onOpenAuthor: (channelId: string, name: string, thumbnail: string | null) => void;
}) {
  const key = commentKey(generation, videoId, sort);
  const entry = useSyncExternalStore(cache.subscribe, () => cache.get(key));
  useEffect(() => {
    if (!isDesktop) return;
    cache.activate(key); void cache.ensure(key, videoId, sort);
    return () => cache.activate(null);
  }, [cache, key, sort, videoId]);
  if (!isDesktop) return null;
  const initial = !entry || (entry.loading && !entry.loaded);
  return <section className="comments-section" aria-label="Comments">
    <div className="comments-heading"><h2>{entry?.totalCount != null ? `${entry.totalCount.toLocaleString()} comments` : 'Comments'}</h2><div className="comments-heading-actions"><CommentSortMenu sort={sort} disabled={entry?.disabled} onSort={onSort} /><IconButton label="Refresh comments" disabled={!!entry?.loading} onClick={() => void cache.refresh(key, videoId, sort)}><RefreshCw size={17} className={entry?.loading && entry.loaded ? 'spin' : ''} /></IconButton></div></div>
    <p className="comments-readonly">Comments from YouTube. Viewing only.</p>
    {initial ? <div className="comments-loading" role="status"><LoaderCircle size={18} className="spin" />Loading comments…</div> : entry?.disabled ? <div className="comments-empty"><MessageSquareOff size={23} /><p>Comments are turned off for this video.</p></div> : <>
      {entry?.error && <div className="comments-error" role="alert"><AlertCircle size={18} /><p>{entry.error}</p><button className="button secondary small" onClick={() => void (entry.errorCode === 'comments_changed' ? cache.refresh(key, videoId, sort) : cache.retry(key))}>{entry.errorCode === 'comments_changed' ? 'Refresh comments' : 'Retry'}</button></div>}
      {!!entry?.items.length && <div className="comment-list" key={key}>{entry.items.map(comment => <CommentRow key={comment.id}
        comment={comment} generation={generation} duration={duration} onSeek={onSeek} onOpenAuthor={onOpenAuthor} replyScope={{ videoId, sort }} />)}</div>}
      {!entry?.items.length && !entry?.error && <div className="comments-empty"><MessageSquare size={23} /><p>No comments to show.</p></div>}
      {entry?.nextCursor && !entry.limited && <div className="comments-load-more"><button className="button secondary" disabled={entry.loadingMore} onClick={() => void cache.loadMore(key)}>{entry.loadingMore ? <LoaderCircle size={17} className="spin" /> : <ChevronDown size={17} />}{entry.loadingMore ? 'Loading…' : 'Load more comments'}</button></div>}
      {entry?.limited && <p className="comments-limit">Showing the first {COMMENT_LIMIT} comments for this sort order.</p>}
    </>}
  </section>;
}
