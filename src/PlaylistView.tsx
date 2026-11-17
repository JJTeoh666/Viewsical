import type { CSSProperties } from 'react';
import { ArrowDownToLine, Headphones, ListVideo, Play } from 'lucide-react';
import type { BrowseEntry } from './browseCache';
import type { CollectionSummary, MediaItem, PlaybackMode } from './types';
import type { QueueState } from './queue';
import { views } from './format';
import { IconButton, Thumbnail } from './ui';
import { ScrollLoader } from './ScrollLoader';

export function PlaylistView({ entry, fallback, queue, onStart, onDownload, onMore }: { entry: BrowseEntry; fallback?: CollectionSummary; queue: QueueState; onStart: (index: number, mode?: PlaybackMode) => void; onDownload: (item: MediaItem) => void; onMore: () => void }) {
  const collection = entry.collection ?? fallback;
  const items = entry.items.filter(item => item.kind === 'video');
  const cover = collection?.thumbnail || items[0]?.thumbnail;
  const selected = queue.source?.key === entry.key ? queue.entries.find(value => value.entryId === queue.selectedEntryId) : null;
  return <div className="playlist-layout"><aside className="playlist-hero" style={cover ? { '--playlist-cover': `url("${cover.replaceAll('"', '%22')}")` } as CSSProperties : undefined}><div className="playlist-hero-content">
    {cover ? <img className="playlist-cover" src={cover} alt="" referrerPolicy="no-referrer" /> : <div className="playlist-cover playlist-cover-empty"><ListVideo size={60} /></div>}
    <h1>{collection?.title || 'Playlist'}</h1>
    {collection?.owner && <p className="playlist-owner"><span className="owner-avatar">{collection.owner[0].toUpperCase()}</span>{collection.owner}</p>}
    <p className="playlist-description-meta">{collection?.isMix ? 'Mix · continuous queue' : `Playlist${collection?.itemCount != null ? ` · ${collection.itemCount.toLocaleString()} videos` : entry.nextCursor ? ` · ${items.length} loaded` : ` · ${items.length} videos`}`}</p>
    {collection?.description && <p className="playlist-description">{collection.description}</p>}
    <div className="playlist-primary-actions"><button className="button playlist-play-all" onClick={() => onStart(0)}><Play size={18} fill="currentColor" />Play all</button><button className="button playlist-audio-all" onClick={() => onStart(0, 'audio')}><Headphones size={18} />Listen</button></div>
  </div></aside><section className="playlist-videos" aria-label="Playlist videos"><div className="playlist-list-heading"><span>Playlist order</span><span>{items.length.toLocaleString()} {entry.nextCursor ? 'loaded' : 'videos'}</span></div>
    {items.map((item, index) => <article className={`playlist-row ${selected?.sourceIndex === (item.playlistIndex ?? index + 1) ? 'selected' : ''}`} key={`${item.playlistIndex ?? index}:${index}`}><span className="playlist-row-number">{selected?.sourceIndex === (item.playlistIndex ?? index + 1) ? <Play size={15} fill="currentColor" /> : item.playlistIndex ?? index + 1}</span><button className="playlist-row-main" onClick={() => onStart(index)} aria-label={`Play ${item.title} from this playlist`}><Thumbnail item={item} /><span className="playlist-row-copy"><strong>{item.title}</strong><span>{item.channel}{views(item.viewCount) && ` · ${views(item.viewCount)}`}</span></span></button><div className="playlist-row-actions"><IconButton label={`Play ${item.title} as audio`} onClick={() => onStart(index, 'audio')}><Headphones size={18} /></IconButton><IconButton label={`Download ${item.title}`} onClick={() => onDownload(item)}><ArrowDownToLine size={18} /></IconButton></div></article>)}
    {entry.nextCursor && <ScrollLoader key={entry.key} scope={entry.key} cursor={entry.nextCursor} loading={entry.loadingMore || entry.loading} error={entry.error} onLoad={onMore} />}
  </section></div>;
}
