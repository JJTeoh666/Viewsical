import { useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, FormEvent, ReactNode } from 'react';
import { AlertCircle, ArrowDownToLine, Download, Film, Folder, ListVideo, LoaderCircle, Music2, Play, Plus, UserCircle, Video, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from './api';
import appIcon from './assets/app-icon.png';
import { errorMessage, time, views } from './format';
import type { AppSettings, DownloadTask, MediaItem, PlayerState } from './types';

export function IconButton({ label, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" title={label} aria-label={label} className={`icon-button ${className}`} {...rest}>{children}</button>;
}

export function Logo({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? 'brand-small' : ''}`} aria-label="Viewsical"><span className="brand-mark"><img className="brand-artwork" src={appIcon} alt="" /></span><span className="brand-word">Viewsical</span></span>;
}

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <div className="modal-header"><h2 id={titleId}>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={21} /></IconButton></div>
    {children}
  </dialog>;
}

export function EmptyState({ icon: Icon = Film, title, children, action }: { icon?: LucideIcon; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol"><Icon size={36} strokeWidth={1.4} /></div><h2>{title}</h2><div className="empty-description">{children}</div>{action && <div className="empty-actions">{action}</div>}</div>;
}

export function Thumbnail({ item, className = '', showDuration = true }: { item: MediaItem; className?: string; showDuration?: boolean }) {
  return <span className={`thumbnail ${item.kind === 'channel' ? 'thumbnail-channel' : ''} ${className}`}>
    <span className="thumbnail-fallback">{item.kind === 'channel' ? <UserCircle size={42} strokeWidth={1.25} /> : <Play size={35} strokeWidth={1.25} />}</span>
    {item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} />}
    {showDuration && item.duration != null && item.duration > 0 && item.kind !== 'channel' && <span className="duration-tag">{time(item.duration)}</span>}
    {item.kind === 'playlist' && <span className="playlist-tag"><ListVideo size={15} /> Playlist</span>}
  </span>;
}

export function VideoCard({ item, onActivate, onDownload, onQueue, onOpenChannel, onOpenPlaylist, starting, row = false }: {
  item: MediaItem; onActivate: (item: MediaItem) => void; onDownload: (item: MediaItem) => void; onQueue: (item: MediaItem) => void;
  onOpenChannel?: (item: MediaItem) => void; onOpenPlaylist?: (item: MediaItem) => void; starting?: boolean; row?: boolean;
}) {
  return <article className={`video-card ${row ? 'video-row' : ''} ${item.kind === 'channel' ? 'channel-card' : ''}`}>
    <button className="thumbnail-button" onClick={() => onActivate(item)} aria-label={`${item.kind === 'video' || onOpenPlaylist ? 'Play' : 'Open'} ${item.title}`} aria-busy={starting || undefined}><Thumbnail item={item} /></button>
    <div className="video-card-body"><div className="card-copy"><button className="video-title text-button" onClick={() => onActivate(item)} title={item.title}>{item.title}</button>
      {item.channel && (onOpenChannel
        ? <button type="button" className="video-channel text-button card-channel-link" title={item.channel} onClick={() => onOpenChannel(item)}>{item.channel}</button>
        : <div className="video-channel">{item.channel}</div>)}
      <div className="video-meta">{views(item.viewCount)}{!item.viewCount && item.kind === 'channel' ? 'Channel' : ''}</div>
      {onOpenPlaylist && <button type="button" className="video-channel text-button card-channel-link" onClick={() => onOpenPlaylist(item)}>View full playlist</button>}
      {starting && <div className="video-meta" role="status">Starting playlist…</div>}
      {row && item.description && <p className="result-description">{item.description}</p>}
    </div>
    {item.kind === 'video' && <div className="card-actions"><IconButton label={`Add ${item.title} to queue`} onClick={() => onQueue(item)}><Plus size={18} /></IconButton><IconButton label={`Download ${item.title}`} onClick={() => onDownload(item)}><ArrowDownToLine size={18} /></IconButton></div>}
    </div>
  </article>;
}

export function Skeletons({ rows = false }: { rows?: boolean }) {
  return <div className={rows ? 'result-list' : 'video-grid'} aria-label="Loading videos" aria-busy="true">{Array.from({ length: rows ? 5 : 8 }, (_, index) => <div className={`skeleton-card ${rows ? 'skeleton-row' : ''}`} key={index}><div className="skeleton skeleton-image" /><div className="skeleton-copy"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line short" /></div></div>)}</div>;
}

export function DownloadDialog({ item, settings, player, onClose, onAdded, onError }: { item: MediaItem; settings: AppSettings; player: PlayerState; onClose: () => void; onAdded: (task: DownloadTask) => void; onError: (error: unknown) => void }) {
  const [mode, setMode] = useState('video');
  const [format, setFormat] = useState('mp4');
  const [quality, setQuality] = useState(settings.defaultQuality);
  const [directory, setDirectory] = useState(settings.downloadDirectory);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const qualities = player.video?.id === item.id && player.qualities.length ? [...player.qualities].sort((a, b) => b - a) : [2160, 1440, 1080, 720, 480, 360];
  const exactQualities = player.video?.id === item.id && player.qualities.length > 0;
  const options = qualities.includes(quality) ? qualities : [...qualities, quality].sort((a, b) => b - a);
  async function start(event: FormEvent) {
    event.preventDefault(); setBusy(true); setFailure('');
    try { const task = await api.enqueueDownload({ item, mode, format: mode === 'audio' ? 'original' : format, quality, directory: directory.trim() || null }); onAdded(task); onClose(); }
    catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <Modal title="Download" onClose={onClose}><form onSubmit={event => void start(event)}>
    <div className="download-preview"><Thumbnail item={item} /><div><h3>{item.title}</h3><p>{item.channel}</p></div></div>
    <div className="segmented" aria-label="Download type"><button type="button" className={mode === 'video' ? 'selected' : ''} aria-pressed={mode === 'video'} onClick={() => setMode('video')}><Video size={17} /> Video</button><button type="button" className={mode === 'audio' ? 'selected' : ''} aria-pressed={mode === 'audio'} onClick={() => setMode('audio')}><Music2 size={17} /> Audio only</button></div>
    {mode === 'video' ? <div className="form-row"><label className="field">Quality<select value={quality} onChange={event => setQuality(Number(event.target.value))}>{options.map(value => <option value={value} key={value}>{exactQualities ? `${value}p` : `Up to ${value}p`}</option>)}</select></label><label className="field">File format<select value={format} onChange={event => setFormat(event.target.value)}><option value="mp4">MP4 · H.264 / AAC</option><option value="mkv">MKV · best source codecs</option></select></label></div> : <div className="info-note"><Music2 size={19} /><p>Keep the original audio quality. Files are saved as M4A or Opus, depending on the available source.</p></div>}
    {mode === 'video' && <p className="field-help">{format === 'mp4' ? 'MP4 uses compatible H.264 video and AAC audio. Choose MKV for more source-quality options.' : 'MKV preserves the selected source codecs without re-encoding.'}{!exactQualities && ' The best available quality within your limit will be selected.'}</p>}
    <label className="field">Save to<div className="folder-field"><input value={directory} onChange={event => setDirectory(event.target.value)} placeholder="Default download folder" aria-label="Download folder" /><IconButton label="Choose download folder" onClick={() => { void api.selectDirectory().then(path => { if (path) setDirectory(path); }).catch(onError); }}><Folder size={20} /></IconButton></div></label>
    {failure && <div className="inline-error" role="alert"><AlertCircle size={18} /><span>{failure}</span></div>}
    <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}{busy ? 'Adding download…' : 'Download'}</button></div>
  </form></Modal>;
}

