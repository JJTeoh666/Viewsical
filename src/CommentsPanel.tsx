import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertCircle, Check, ChevronDown, Clock3, ListFilter, LoaderCircle, MessageSquare, MessageSquareOff, Pin, RefreshCw, ThumbsUp } from 'lucide-react';
import { isDesktop } from './api';
import { COMMENT_LIMIT, CommentCache, commentKey } from './commentCache';
import { IconButton } from './ui';
import type { CommentSort, VideoComment } from './types';
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

function CommentRow({ comment }: { comment: VideoComment }) {
  const [expanded, setExpanded] = useState(false);
  const long = comment.text.length > 350 || comment.text.split('\n').length > 4;
  return <article className="comment-row">
    <div className="comment-avatar" aria-hidden="true">{comment.authorThumbnail ? <img src={comment.authorThumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} /> : (comment.author[0] || '?').toUpperCase()}</div>
    <div className="comment-body">{comment.isPinned && <div className="comment-pinned"><Pin size={12} />Pinned</div>}<div className="comment-author"><strong>{comment.author || 'YouTube user'}</strong>{comment.authorIsUploader && <span className="comment-creator">Creator</span>}{comment.published && <time>{comment.published}</time>}</div>
      <p className={`comment-text ${long && !expanded ? 'comment-collapsed' : ''}`} dir="auto">{comment.text}</p>
      {long && <button className="comment-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Read more'}</button>}
      {(comment.likeCount != null || comment.replyCount != null) && <div className="comment-counts">{comment.likeCount != null && <span aria-label={`${comment.likeCount.toLocaleString()} likes`}><ThumbsUp size={14} />{comment.likeCount.toLocaleString()}</span>}{comment.replyCount != null && comment.replyCount > 0 && <span>{comment.replyCount.toLocaleString()} {comment.replyCount === 1 ? 'reply' : 'replies'}</span>}</div>}
    </div>
  </article>;
}

export function CommentsPanel({ videoId, generation, cache, sort, onSort }: { videoId: string; generation: number; cache: CommentCache; sort: CommentSort; onSort: (sort: CommentSort) => void }) {
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
      {!!entry?.items.length && <div className="comment-list">{entry.items.map(comment => <CommentRow key={comment.id} comment={comment} />)}</div>}
      {!entry?.items.length && !entry?.error && <div className="comments-empty"><MessageSquare size={23} /><p>No comments to show.</p></div>}
      {entry?.nextCursor && !entry.limited && <div className="comments-load-more"><button className="button secondary" disabled={entry.loadingMore} onClick={() => void cache.loadMore(key)}>{entry.loadingMore ? <LoaderCircle size={17} className="spin" /> : <ChevronDown size={17} />}{entry.loadingMore ? 'Loading…' : 'Load more comments'}</button></div>}
      {entry?.limited && <p className="comments-limit">Showing the first {COMMENT_LIMIT} comments for this sort order.</p>}
    </>}
  </section>;
}
