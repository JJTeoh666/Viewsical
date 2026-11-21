import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { api } from './api';
import { errorMessage } from './format';
import type { SubtitleTrack } from './types';

export function SubtitleOptions({ loadId, selected }: { loadId: number; selected: string | null }) {
  const [tracks, setTracks] = useState<SubtitleTrack[] | null>(null);
  const [lookupError, setLookupError] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    void api.subtitleTracks(loadId).then(
      result => { if (current) setTracks(result); },
      error => { if (current) setLookupError(errorMessage(error)); },
    );
    return () => { current = false; };
  }, [loadId, retry]);

  async function select(id: string | null) {
    if (saving || id === selected) return;
    setSaving(true);
    setSelectionError('');
    try {
      await api.setSubtitle(loadId, id);
    } catch (error) {
      setSelectionError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return <>
    {(selected || !!tracks?.length) && <button role="menuitemradio" aria-checked={selected === null} aria-disabled={saving} onClick={() => void select(null)}>
      <span className="menu-check">{selected === null && <Check size={17} />}</span><span>Off</span>
    </button>}
    {tracks?.map(track => <button role="menuitemradio" key={track.id} aria-checked={selected === track.id} aria-disabled={saving} onClick={() => void select(track.id)}>
      <span className="menu-check">{selected === track.id && <Check size={17} />}</span>
      <span>{track.label}</span>{track.automatic && <small>Auto-generated</small>}
    </button>)}
    {lookupError && <>
      <p className="subtitle-menu-status" role="status">{lookupError}</p>
      <button role="menuitem" onClick={() => { setLookupError(''); setRetry(value => value + 1); }}>Try again</button>
    </>}
    {!tracks && !lookupError && <p className="subtitle-menu-status" role="status">Looking for subtitles…</p>}
    {tracks?.length === 0 && !selected && <p className="subtitle-menu-status" role="status">No subtitles available for this video.</p>}
    {saving && <p className="subtitle-menu-status" role="status">Updating subtitles…</p>}
    {selectionError && <p className="subtitle-menu-status" role="status">{selectionError}</p>}
  </>;
}
