import { useRef } from 'react';
import { ArrowDownToLine, Play, Plus, Trash2, X } from 'lucide-react';
import { views } from './format';
import type { QueueEntry, QueueState } from './queue';
import { selectedIndex } from './queue';
import type { MediaItem } from './types';
import { IconButton, Thumbnail } from './ui';
import { ScrollLoader } from './ScrollLoader';

export function WatchInfo({ video, onQueue, onDownload }: { video: MediaItem; onQueue: (item: MediaItem) => void; onDownload: (item: MediaItem) => void }) {
  return <div className="video-details"><h1>{video.title}</h1><div className="watch-info-row"><div className="channel-info"><span className="channel-avatar">{(video.channel || 'Y')[0].toUpperCase()}</span><div><strong>{video.channel || 'YouTube'}</strong><span>{views(video.viewCount) || 'YouTube video'}</span></div></div><div className="watch-actions"><button className="button secondary" onClick={() => onQueue(video)}><Plus size={18} />Queue</button><button className="button secondary" onClick={() => onDownload(video)}><ArrowDownToLine size={18} />Download</button></div></div>{video.description && <details className="description-box"><summary>Description</summary><p>{video.description}</p></details>}</div>;
}
export function QueuePanel({ queue, onSelect, onRemove, onClear, onMore, onRetry }: { queue: QueueState; onSelect: (entry: QueueEntry) => void; onRemove: (id: string) => void; onClear: () => void; onMore: () => void; onRetry: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  return <section className="queue-panel"><div className="queue-heading"><div><h2>{queue.source?.collection?.title || (queue.isMix ? 'Mix' : 'Play queue')}</h2><span>{selectedIndex(queue) + 1} / {queue.entries.length}{!queue.complete ? '+' : ''}</span></div>{queue.entries.length > 1 && <IconButton label="Clear upcoming queue" onClick={onClear}><Trash2 size={17} /></IconButton>}</div><div className="queue-list" ref={list}>{queue.entries.length ? queue.entries.map((entry, index) => <div className={`queue-item ${entry.entryId === queue.selectedEntryId ? 'current' : ''}`} key={entry.entryId}><span className="queue-index">{entry.entryId === queue.selectedEntryId ? <Play size={12} fill="currentColor" /> : queue.source && entry.sourceIndex > 0 ? entry.sourceIndex : index + 1}</span><button className="queue-video" onClick={() => onSelect(entry)}><Thumbnail item={entry.item} /><span><strong>{entry.item.title}</strong><small>{entry.item.channel}</small></span></button><IconButton label={`Remove ${entry.item.title} from queue`} onClick={() => onRemove(entry.entryId)}><X size={15} /></IconButton></div>) : <p className="muted queue-empty">Add videos to keep watching.</p>}{queue.nextCursor && <ScrollLoader key={queue.id} scope={queue.id} cursor={queue.nextCursor} loading={queue.loading} error={queue.error} onLoad={queue.error ? onRetry : onMore} scrollRoot={list} compact />}</div>{queue.error && <div className="queue-load-error"><p>{queue.error}</p><button className="text-link" onClick={onRetry}>Retry playlist loading</button></div>}</section>;
}
