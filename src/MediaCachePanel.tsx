import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, HardDrive, Headphones, LoaderCircle, RefreshCw, ShieldCheck, Trash2, Video } from 'lucide-react';
import { api, isDesktop } from './api';
import { bytes, errorMessage, relativeDate } from './format';
import { IconButton } from './ui';
import type { MediaCacheContent, MediaCacheKind, MediaCacheSummary } from './types';
import { cacheUsage, cacheLimits as limits, GiB } from './mediaCache';

export function MediaCachePanel({ generation }: { generation: number }) {
  const [summary, setSummary] = useState<MediaCacheSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showFiles, setShowFiles] = useState(false);
  const [visibleFiles, setVisibleFiles] = useState(20);
  const revision = useRef(0);
  const mounted = useRef(false);
  const generationRef = useRef(generation); generationRef.current = generation;

  async function refresh() {
    const token = ++revision.current; const session = generationRef.current; setBusy('refresh'); setError('');
    try { const data = await api.cacheSummary(); if (mounted.current && session === generationRef.current && token === revision.current) setSummary(data); }
    catch (failure) { if (mounted.current && session === generationRef.current) setError(errorMessage(failure)); }
    finally { if (mounted.current && session === generationRef.current) setBusy(null); }
  }
  useEffect(() => {
    if (!isDesktop) return;
    mounted.current = true; setSummary(null); setNotice(''); setError(''); setVisibleFiles(20);
    void refresh(); let disposed = false; let unsubscribe: (() => void) | undefined;
    void api.on<MediaCacheSummary>('cache-changed', value => { if (!disposed) { revision.current += 1; setSummary(value); } }).then(value => { if (disposed) value(); else unsubscribe = value; }).catch(failure => { if (!disposed) setError(errorMessage(failure)); });
    return () => { mounted.current = false; disposed = true; revision.current += 1; unsubscribe?.(); };
  // The storage partition follows the account generation, independently of navigation.
  }, [generation]);

  async function configure(enabled: boolean, maxBytes: number, content?: MediaCacheContent) {
    const token = ++revision.current; const session = generationRef.current; setBusy('configure'); setError(''); setNotice('');
    try { const data = await api.cacheConfigure(enabled, maxBytes, content); if (mounted.current && session === generationRef.current) { if (token === revision.current) setSummary(data); setNotice(enabled ? 'Cache settings saved.' : 'Media caching is off. Existing cached media is kept until you clear it.'); } }
    catch (failure) { if (mounted.current && session === generationRef.current) setError(errorMessage(failure)); }
    finally { if (mounted.current && session === generationRef.current) setBusy(null); }
  }
  async function clear(kind: MediaCacheKind, entryId?: string) {
    const token = ++revision.current; const session = generationRef.current; const before = summary?.totalBytes ?? 0;
    setBusy(entryId || `clear-${kind}`); setError(''); setNotice('');
    try { const data = await api.cacheClear(kind, entryId); if (mounted.current && session === generationRef.current) { if (token === revision.current) setSummary(data); const freed = Math.max(0, before - data.totalBytes); setNotice(`${freed ? `${bytes(freed)} of cached media cleared.` : 'Cache cleared.'}${data.entries.some(file => file.pinned) ? ` ${data.entries.filter(file => file.pinned).length} currently playing ${data.entries.filter(file => file.pinned).length === 1 ? 'file is' : 'files are'} kept until playback stops.` : ''}`); } }
    catch (failure) { if (mounted.current && session === generationRef.current) setError(errorMessage(failure)); }
    finally { if (mounted.current && session === generationRef.current) setBusy(null); }
  }
  const usage = summary ? cacheUsage(summary) : { audio: 0, video: 0, pending: 0 };
  const pinnedCount = summary?.entries.filter(file => file.pinned).length ?? 0;
  const availableLimits = summary && !limits.includes(summary.maxBytes) ? [...limits, summary.maxBytes].sort((a, b) => a - b) : limits;
  return <section className="settings-section media-cache-section">
    <div className="settings-section-heading"><h2>Media cache</h2><IconButton label="Refresh cache sizes" disabled={!!busy || !isDesktop} onClick={() => void refresh()}><RefreshCw size={17} className={busy === 'refresh' ? 'spin' : ''} /></IconButton></div>
    <p className="settings-note cache-intro">Keep audio and video in the app’s storage for replay. This cache is separate from your saved downloads.</p>
    {!isDesktop ? <p className="settings-note">Cache controls are available in the desktop app.</p> : !summary && !error ? <div className="cache-loading" role="status"><LoaderCircle size={18} className="spin" />Checking cached media…</div> : summary && <>
      <div className="setting-row"><div><label className="setting-title" htmlFor="media-cache-enabled">Store media for replay</label><p>Items up to 5 minutes long can be cached in the background. This uses additional network data.</p></div><label className="cache-switch"><input id="media-cache-enabled" type="checkbox" role="switch" checked={summary.enabled} disabled={!!busy} onChange={event => void configure(event.target.checked, summary.maxBytes)} /><span aria-hidden="true" /></label></div>
      <div className="setting-row">
        <div><label className="setting-title" htmlFor="media-cache-content">What to cache</label><p id="media-cache-content-hint">Video-only caching saves playable videos with sound. This choice applies to new cache files.</p></div>
        <select id="media-cache-content" aria-describedby="media-cache-content-hint" value={summary.content ?? 'both'} disabled={!!busy || !summary.enabled}
          onChange={event => void configure(summary.enabled, summary.maxBytes, event.target.value as MediaCacheContent)}>
          <option value="both">Audio and video</option><option value="audio">Audio only</option><option value="video">Video only</option>
        </select>
      </div>
      <div className="setting-row"><div><strong>Cache size limit</strong><p>Older unused media is removed when space is needed.</p></div><select aria-label="Cache size limit" value={summary.maxBytes} disabled={!!busy} onChange={event => void configure(summary.enabled, Number(event.target.value))}>{availableLimits.map(value => <option value={value} key={value}>{value < GiB ? '512 MB' : `${value / GiB} GB`}</option>)}</select></div>
      <div className="cache-usage-heading"><strong>{bytes(summary.totalBytes)} <span>of {bytes(summary.maxBytes)}</span></strong><span>{summary.entryCount.toLocaleString()} cached {summary.entryCount === 1 ? 'file' : 'files'}</span></div>
      <div className="cache-usage-bar" role="meter" aria-label="Cache storage used" aria-valuemin={0} aria-valuemax={summary.maxBytes} aria-valuenow={Math.min(summary.totalBytes, summary.maxBytes)} aria-valuetext={`${bytes(summary.totalBytes)} used of ${bytes(summary.maxBytes)}`}><span className="cache-audio-segment" style={{ width: `${usage.audio}%` }} /><span className="cache-video-segment" style={{ width: `${usage.video}%` }} /><span className="cache-pending-segment" style={{ width: `${usage.pending}%` }} /></div>
      <div className="cache-breakdown"><span><Headphones size={15} /><strong>Audio</strong>{bytes(summary.audioBytes)}</span><span><Video size={15} /><strong>Video</strong>{bytes(summary.videoBytes)}</span>{summary.pendingBytes > 0 && <span><LoaderCircle size={15} className="spin" /><strong>In progress</strong>{bytes(summary.pendingBytes)}</span>}</div>
      <div className="cache-clear-actions"><button className="button secondary small" disabled={!!busy || !summary.audioBytes} onClick={() => void clear('audio')}>Clear audio</button><button className="button secondary small" disabled={!!busy || !summary.videoBytes} onClick={() => void clear('video')}>Clear video</button><button className="button secondary small" disabled={!!busy || !summary.totalBytes} onClick={() => void clear('all')}>{busy?.startsWith('clear') ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}Clear all cached media</button></div>
      <div className="cache-safety-note"><ShieldCheck size={18} /><p>Currently playing cached files are kept until playback stops. Clearing this cache leaves your downloaded files, sign-in, and watch history unchanged.</p></div>
      {summary.activeCount > 0 && <p className="cache-worker-note" role="status"><LoaderCircle size={14} className="spin" />Caching {summary.activeCount > 1 ? `${summary.activeCount} media items ` : 'media '}in the background…</p>}{pinnedCount > 0 && <p className="cache-active-note">{pinnedCount} cached {pinnedCount === 1 ? 'file is' : 'files are'} currently playing and will be kept until playback stops.</p>}
      {summary.entries.length > 0 && <><button className="cache-files-toggle" aria-expanded={showFiles} onClick={() => setShowFiles(value => !value)}><HardDrive size={16} />{showFiles ? 'Hide cached files' : 'View cached files'}<ChevronDown size={16} className={showFiles ? 'chevron-open' : ''} /></button>{showFiles && <div className="cache-files">{summary.entries.slice(0, visibleFiles).map(file => <div className="cache-file-row" key={file.id}><span className="cache-file-type">{file.mode === 'audio' ? <Headphones size={19} /> : <Video size={19} />}</span><div className="cache-file-copy"><strong>{file.title || file.videoId}</strong><span>{file.mode === 'audio' ? 'Audio' : `${file.quality}p video`}<span className="metadata-separator">·</span>{bytes(file.bytes)}{file.lastAccessed > 0 && <><span className="metadata-separator">·</span>Used {relativeDate(file.lastAccessed)}</>}{file.pinned && <span className="cache-pinned-label">In use</span>}</span></div><IconButton label={file.pinned ? `Clear cached ${file.title || file.videoId} after playback` : `Remove cached ${file.title || file.videoId}`} disabled={!!busy} onClick={() => void clear(file.mode === 'audio' ? 'audio' : 'video', file.id)}>{busy === file.id ? <LoaderCircle size={17} className="spin" /> : <Trash2 size={17} />}</IconButton></div>)}{visibleFiles < summary.entries.length && <button className="button secondary small" onClick={() => setVisibleFiles(value => value + 20)}>Show more cached files</button>}</div>}</>}
    </>}
    {error && <div className="cache-panel-error" role="alert"><AlertCircle size={18} /><span>{error}</span><button className="button secondary small" disabled={!!busy} onClick={() => void refresh()}>Retry</button></div>}
    {notice && <p className="cache-panel-notice" role="status">{notice}</p>}
  </section>;
}
