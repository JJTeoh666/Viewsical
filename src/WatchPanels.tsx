import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Play, Plus, Trash2, X } from 'lucide-react';
import { browseKey, type BrowseCache } from './browseCache';
import { uniqueItems, views } from './format';
import type { QueueEntry, QueueState } from './queue';
import { selectedIndex } from './queue';
import type { BrowseKind, MediaItem } from './types';
import type { OpenVideoChannel } from './WatchInfo';
import { IconButton, Thumbnail } from './ui';
import { ScrollLoader } from './ScrollLoader';

export function QueuePanel({ queue, onSelect, onRemove, onClear, onMore, onRetry }: { queue: QueueState; onSelect: (entry: QueueEntry) => void; onRemove: (id: string) => void; onClear: () => void; onMore: () => void; onRetry: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  return <section className="queue-panel"><div className="queue-heading"><div><h2>{queue.source?.collection?.title || (queue.isMix ? 'Mix' : 'Play queue')}</h2><span>{selectedIndex(queue) + 1} / {queue.entries.length}{!queue.complete ? '+' : ''}</span></div>{queue.entries.length > 1 && <IconButton label="Clear upcoming queue" onClick={onClear}><Trash2 size={17} /></IconButton>}</div><div className="queue-list" ref={list}>{queue.entries.length ? queue.entries.map((entry, index) => <div className={`queue-item ${entry.entryId === queue.selectedEntryId ? 'current' : ''}`} key={entry.entryId}><span className="queue-index">{entry.entryId === queue.selectedEntryId ? <Play size={12} fill="currentColor" /> : queue.source && entry.sourceIndex > 0 ? entry.sourceIndex : index + 1}</span><button className="queue-video" onClick={() => onSelect(entry)}><Thumbnail item={entry.item} /><span><strong>{entry.item.title}</strong><small>{entry.item.channel}</small></span></button><IconButton label={`Remove ${entry.item.title} from queue`} onClick={() => onRemove(entry.entryId)}><X size={15} /></IconButton></div>) : <p className="muted queue-empty">Add videos to keep watching.</p>}{queue.nextCursor && <ScrollLoader key={queue.id} scope={queue.id} cursor={queue.nextCursor} loading={queue.loading} error={queue.error} onLoad={queue.error ? onRetry : onMore} scrollRoot={list} compact />}</div>{queue.error && <div className="queue-load-error"><p>{queue.error}</p><button className="text-link" onClick={onRetry}>Retry playlist loading</button></div>}</section>;
}

export interface RecommendationSource {
  kind: BrowseKind;
  query: string;
  label: string;
}

const defaultSource: RecommendationSource = { kind: 'home', query: '', label: 'More to watch' };
const batchSize = 8;

function outsideQueue(items: MediaItem[] | undefined, queuedIds: ReadonlySet<string>) {
  return uniqueItems(items?.filter(item => item.kind === 'video' && !queuedIds.has(item.id)) ?? []);
}

export function WatchRecommendations({ cache, generation, canBrowse, entries, video, topic, source = defaultSource, onPlay, onQueue, onOpenChannel }: {
  cache: BrowseCache;
  generation: number;
  canBrowse: boolean;
  entries: QueueEntry[] | undefined;
  video: MediaItem;
  topic: string | undefined;
  source?: RecommendationSource;
  onPlay: (item: MediaItem, source: RecommendationSource) => void;
  onQueue: (item: MediaItem) => void;
  onOpenChannel: OpenVideoChannel;
}) {
  const sourceKey = browseKey(generation, source.kind, source.query);
  const initial = useSyncExternalStore(cache.subscribe, () => cache.get(sourceKey));
  const queuedIds = useMemo(() => new Set([video.id, ...(entries?.map(entry => entry.item.id) ?? [])]), [entries, video.id]);
  const initialVideos = useMemo(() => outsideQueue(initial?.items, queuedIds), [initial?.items, queuedIds]);
  const useSearch = source.kind !== 'search' && initial?.attempted && !initial.loading && !initialVideos.length && (!initial.nextCursor || !!initial.error);
  const query = useSearch ? (topic || video.title).trim().slice(0, 120) : '';
  const searchKey = query ? browseKey(generation, 'search', query) : '';
  const related = useSyncExternalStore(cache.subscribe, () => searchKey ? cache.get(searchKey) : undefined);
  useEffect(() => {
    if (canBrowse) void cache.ensure(sourceKey, source.kind, source.query).catch(() => {});
  }, [cache, canBrowse, sourceKey, source.kind, source.query]);
  useEffect(() => {
    if (canBrowse && searchKey) void cache.ensure(searchKey, 'search', query).catch(() => {});
  }, [cache, canBrowse, query, searchKey]);
  const relatedVideos = useMemo(() => outsideQueue(related?.items, queuedIds), [related?.items, queuedIds]);
  const active = searchKey ? related : initial;
  const activeSource: RecommendationSource = searchKey ? { kind: 'search', query, label: source.label } : source;
  const key = searchKey || sourceKey;
  const items = searchKey ? relatedVideos : initialVideos;
  const [limit, setLimit] = useState({ key, count: batchSize });
  const count = limit.key === key ? limit.count : batchSize;
  const visible = items.slice(0, count);
  const loading = Boolean(active?.loading || active?.loadingMore);
  const canLoadMore = items.length > count || !!active?.nextCursor || !!active?.error;

  async function loadMore() {
    if (!active || loading) return;
    if (items.length > count) {
      setLimit({ key, count: count + batchSize });
      return;
    }
    try {
      if (active.nextCursor) await cache.loadMore(key);
      else await cache.refresh(key, active.kind, active.query);
      setLimit({ key, count: visible.length + batchSize });
    } catch { /* The cache exposes the error and the button retries it. */ }
  }

  if (!visible.length && !canLoadMore && !loading) return null;
  return <section className="recommendations" aria-label={source.label} aria-busy={loading}>
    <h2>{source.label}</h2>
    {visible.map(item => <div className="recommendation" key={item.id}>
      <button type="button" className="recommendation-thumbnail" aria-label={`Play ${item.title}`}
        onClick={() => onPlay(item, activeSource)}><Thumbnail item={item} /></button>
      <div className="recommendation-copy">
        <button type="button" className="recommendation-title" title={item.title} onClick={() => onPlay(item, activeSource)}>{item.title}</button>
        {item.channel && <button type="button" className="recommendation-channel" aria-label={`Open ${item.channel} channel`}
          title={item.channel} onClick={() => onOpenChannel(item)}>{item.channel}</button>}
        {views(item.viewCount) && <small>{views(item.viewCount)}</small>}
      </div>
      <IconButton label={`Add ${item.title} to queue`} onClick={() => onQueue(item)}><Plus size={17} /></IconButton>
    </div>)}
    {active?.error && <p className="recommendation-error" role="alert">{active.error}</p>}
    {(canLoadMore || loading) && <button type="button" className="button secondary recommendation-more"
      disabled={loading || (!canBrowse && items.length <= count)} onClick={() => void loadMore()}>
      {loading ? 'Loading…' : active?.error && items.length <= count ? 'Retry' : 'Load more'}
    </button>}
  </section>;
}
