import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, Link, ListPlus, ListVideo, LoaderCircle, Trash2 } from 'lucide-react';
import { api } from './api';
import type { BrowseEntry } from './browseCache';
import { errorMessage } from './format';
import { PlaylistView } from './PlaylistView';
import type { QueueState } from './queue';
import type { CollectionSummary, MediaItem, PlaybackMode } from './types';
import { EmptyState, IconButton, Modal, Skeletons } from './ui';
import './local-playlists.css';

export function LocalPlaylists({ onOpen }: { onOpen: (playlist: CollectionSummary) => void }) {
  const [playlists, setPlaylists] = useState<CollectionSummary[]>([]);
  const [link, setLink] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [remove, setRemove] = useState<CollectionSummary | null>(null);

  useEffect(() => {
    let active = true;
    void api.localPlaylists().then(items => { if (active) setPlaylists(items); })
      .catch(reason => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function importPlaylist(event: FormEvent) {
    event.preventDefault();
    const input = link.trim();
    if (!input || busy || loading) return;
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const saved = await api.importLocalPlaylist(input);
      setPlaylists(items => [saved, ...items.filter(item => item.id !== saved.id)]);
      setLink('');
      setFeedback(`Imported ${saved.title}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removePlaylist(playlist: CollectionSummary) {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      await api.removeLocalPlaylist(playlist.id);
      setPlaylists(items => items.filter(item => item.id !== playlist.id));
      setRemove(null);
      setFeedback(`Removed ${playlist.title}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section className="local-playlists" aria-label="Local playlists">
    <form className="local-playlist-form" onSubmit={importPlaylist}>
      <label htmlFor="local-playlist-link">YouTube playlist link</label>
      <div className="local-playlist-input-row">
        <div className="local-playlist-input"><Link size={18} /><input id="local-playlist-link" value={link} onChange={event => setLink(event.target.value)} type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="Paste a playlist link" maxLength={2048} required /></div>
        <button className="button primary" type="submit" disabled={loading || busy || !link.trim()}>{busy && !remove ? <LoaderCircle size={18} className="spin" /> : <ListPlus size={18} />}{busy && !remove ? 'Importing…' : 'Import playlist'}</button>
      </div>
      <p>Imports public and unlisted playlists. The list is saved on this device.</p>
    </form>
    {error && !remove && <div className="inline-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
    <p className="sr-only" role="status">{feedback}</p>
    {loading ? <Skeletons /> : playlists.length > 0
      ? <div className="local-playlist-grid">{playlists.map(playlist => <article className="local-playlist-card" key={playlist.id}>
        <button className="local-playlist-card-main" onClick={() => onOpen(playlist)} aria-label={`Open ${playlist.title}`}>
          <div className="local-playlist-cover">
            {playlist.thumbnail ? <img src={playlist.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <ListVideo size={36} />}
            <span><ListVideo size={15} />{playlist.itemCount === 1 ? '1 video' : `${(playlist.itemCount ?? 0).toLocaleString()} videos`}</span>
          </div>
          <strong>{playlist.title}</strong>
          {playlist.owner && <span className="muted">{playlist.owner}</span>}
        </button>
        <IconButton label={`Remove ${playlist.title}`} disabled={busy} onClick={() => { setError(''); setRemove(playlist); }}><Trash2 size={17} /></IconButton>
      </article>)}</div>
      : <EmptyState icon={ListVideo} title="No local playlists yet">Paste a YouTube playlist link above to add it to your library.</EmptyState>}
    {remove && <Modal title="Remove local playlist?" onClose={() => { if (!busy) setRemove(null); }}>
      <p className="modal-intro">Remove “{remove.title}” from this device?</p>
      {error && <div className="inline-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
      <div className="modal-footer"><button className="button secondary" disabled={busy} onClick={() => setRemove(null)}>Cancel</button><button className="button primary" disabled={busy} onClick={() => void removePlaylist(remove)}>Remove playlist</button></div>
    </Modal>}
  </section>;
}

export function LocalPlaylist({ id, queue, onStart, onDownload }: { id: string; queue: QueueState; onStart: (entry: BrowseEntry, index: number, mode?: PlaybackMode) => void; onDownload: (item: MediaItem) => void }) {
  const [entry, setEntry] = useState<BrowseEntry>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api.localPlaylist(id).then(page => {
      if (active) setEntry({
        key: `local-playlist:${id}`, kind: 'playlist', query: id, items: page.items, nextCursor: null, collection: page.collection ?? null,
        attempted: true, loaded: true, loading: false, loadingMore: false, error: null, scrollY: 0,
      });
    }).catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [id]);
  if (error) return <div className="inline-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>;
  if (!entry) return <Skeletons rows />;
  return <PlaylistView entry={entry} queue={queue} onStart={(index, mode) => onStart(entry, index, mode)} onDownload={onDownload} onMore={() => {}} />;
}
