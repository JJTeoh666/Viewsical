import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, ListPlus, LoaderCircle } from 'lucide-react';
import { api } from './api';
import { errorMessage } from './format';
import type { MediaItem, SessionSnapshot } from './types';
import { Modal } from './ui';

type Destination = { id: string; title: string; saved?: boolean };

export function SaveVideoDialog({ video, session, onClose, onSaved }: {
  video: MediaItem;
  session: SessionSnapshot;
  onClose: () => void;
  onSaved: (title: string, youtube: boolean) => void;
}) {
  const [youtube, setYouTube] = useState(false);
  const [options, setOptions] = useState<Destination[]>();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [retries, setRetries] = useState(0);
  const connected = session.status === 'connected';

  useEffect(() => {
    let active = true;
    const request = youtube ? api.youtubePlaylistOptions(video.id, session.generation) : api.localPlaylists();
    void request.then(list => { if (active) setOptions(list); })
      .catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [youtube, video.id, session.generation, retries]);

  function switchDestination(useYouTube: boolean) {
    if (youtube === useYouTube) return;
    setOptions(undefined);
    setError('');
    setCreating(false);
    setYouTube(useYouTube);
  }

  async function save(option?: Destination) {
    if (pending || (youtube && (!connected || !option))) return;
    const name = option?.title ?? title.trim();
    if (!name) return;
    setPending(true);
    setError('');
    try {
      if (youtube && option) await api.saveYouTubePlaylistVideo(video.id, session.generation, option.id);
      else await api.saveLocalPlaylistVideo(video, option?.id ?? null, option ? null : name);
      onSaved(name, youtube);
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    void save();
  }

  return <Modal title="Add to playlist" onClose={() => { if (!pending) onClose(); }}>
    <p className="save-video-title" title={video.title}>{video.title}</p>
    <div className="segmented save-playlist-destinations" aria-label="Playlist location">
      <button type="button" className={youtube ? '' : 'selected'} aria-pressed={!youtube}
        disabled={pending} onClick={() => switchDestination(false)}>Local playlists</button>
      <button type="button" className={youtube ? 'selected' : ''} aria-pressed={youtube}
        disabled={pending || !connected} title={connected ? undefined : 'Sign in to access your YouTube playlists'}
        onClick={() => switchDestination(true)}>YouTube playlists</button>
    </div>
    {options === undefined && !error && <p className="save-playlist-status" role="status"><LoaderCircle size={17} className="spin" />Loading playlists…</p>}
    {options?.length === 0 && !creating && <p className="save-playlist-status">{youtube ? 'No editable YouTube playlists were found.' : 'No local playlists yet.'}</p>}
    {options && options.length > 0 && <ul className="save-playlist-options" aria-label={youtube ? 'YouTube playlists' : 'Local playlists'}>
      {options.map(option => <li key={option.id}><button type="button" className="save-playlist-option" disabled={pending || option.saved}
        onClick={() => void save(option)}><span>{option.title}</span>{option.saved ? <><Check size={17} /> <span className="sr-only">Already saved</span></> : <ListPlus size={17} />}</button></li>)}
    </ul>}
    {!youtube && (creating ? <form className="save-playlist-create" onSubmit={create}>
      <label className="field">Playlist name<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required disabled={pending} /></label>
      <button className="button primary" disabled={pending || !title.trim()}>Create and save</button>
    </form> : <button type="button" className="button secondary" disabled={pending} onClick={() => setCreating(true)}><ListPlus size={17} />New local playlist</button>)}
    {error && <p className="save-playlist-status" role="alert">{error} {options === undefined &&
      <button type="button" className="text-link" onClick={() => { setError(''); setRetries(value => value + 1); }}>Retry</button>}</p>}
    {pending && <p className="save-playlist-status" role="status"><LoaderCircle size={17} className="spin" />Saving video…</p>}
  </Modal>;
}
