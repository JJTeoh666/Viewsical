import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowLeft, ChevronLeft, ChevronRight, Check, ExternalLink, History, Home, ListVideo, LoaderCircle, LogOut, Menu, Monitor, Play, Plus, RefreshCw, Search, Settings, ShieldCheck, SlidersHorizontal, Trash2, UserCircle, Users, Video, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, isDesktop } from './api';
import { BrowseCache, browseKey } from './browseCache';
import { CommentCache } from './commentCache';
import { CommentsPanel } from './CommentsPanel';
import { DownloadsPanel, HistoryPanel, SettingsPanel } from './LibraryPanels';
import { errorMessage, views } from './format';
import { PlayerHost } from './PlayerHost';
import { usePlayerShortcuts } from './usePlayerInteractions';
import { WindowControls } from './WindowControls';
import './desktop-chrome.css';
import { PlaylistView } from './PlaylistView';
import { ScrollLoader } from './ScrollLoader';
import { QueuePanel, WatchInfo } from './WatchPanels';
import { appendQueuePage, boundMix, emptyQueue, needsQueuePage, playlistQueue, selectedIndex } from './queue';
import type { QueueEntry, QueueState } from './queue';
import { anonymousSession, defaultPlayer, defaultSettings } from './types';
import type { BrowseKind, CollectionSummary, CommentSort, DownloadTask, HistoryItem, MediaItem, Page, PlaybackMode, PlayerAction, PlayerState, PlayerUiRequest, SessionSnapshot, ToolStatus } from './types';
import { DownloadDialog, EmptyState, IconButton, Logo, Modal, Skeletons, Thumbnail, VideoCard } from './ui';

const browseKinds = new Set<string>(['home', 'search', 'subscriptions', 'channels', 'playlists', 'playlist', 'channel']);
const accountPages = new Set(['subscriptions', 'channels', 'playlists']);
const activeDownloads = new Set(['queued', 'resolving', 'downloading', 'merging', 'validating']);

export default function Application() {
  const [settings, setSettings] = useState(defaultSettings);
  const [session, setSession] = useState(anonymousSession);
  const [player, setPlayer] = useState(defaultPlayer);
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [ready, setReady] = useState(!isDesktop);
  const [bootError, setBootError] = useState('');
  const [page, setPage] = useState<Page>({ kind: 'home' });
  const [previousPage, setPreviousPage] = useState<Page>({ kind: 'home' });
  const [sidebar, setSidebar] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [queue, setQueue] = useState<QueueState>(emptyQueue);
  const [recommendations, setRecommendations] = useState<{ items: MediaItem[]; label: string }>({ items: [], label: 'More to watch' });
  const [downloadItem, setDownloadItem] = useState<MediaItem | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState('');
  const [accountMenu, setAccountMenu] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [theater, setTheater] = useState(false);
  const [docked, setDocked] = useState(false);
  const navTrail = useRef<{ pages: Page[]; index: number }>({ pages: [{ kind: 'home' }], index: 0 });
  const [, refreshNavigation] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);
  const [toast, setToast] = useState('');
  const [clearConfirm, setClearConfirm] = useState(false);
  const [commentSort, setCommentSort] = useState<CommentSort>('top');
  const searchRef = useRef<HTMLInputElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef(player);
  const queueRef = useRef(queue);
  const sessionRef = useRef(session);
  const pageRef = useRef(page);
  const sessionGenerationRef = useRef<number | null>(null);
  const advanceRef = useRef(-1);
  const localPlayback = useRef(false);
  const pendingAdvance = useRef<{ queueId: string; entryId: string | null } | null>(null);
  const nativeRequest = useRef<(request: PlayerUiRequest) => void>(() => {});
  const restoredScroll = useRef('');
  const [cache] = useState(() => new BrowseCache((...args) => api.browse(...args), id => { void api.cancelBrowse(id).catch(() => {}); }));
  const [commentCache] = useState(() => new CommentCache((...args) => api.comments(...args), id => { void api.cancelComments(id).catch(() => {}); }));
  const activeKey = browseKinds.has(page.kind) ? browseKey(session.generation, page.kind, page.query) : '';
  const entry = useSyncExternalStore(cache.subscribe, () => activeKey ? cache.get(activeKey) : undefined);
  const items = entry?.items ?? [];
  const connected = session.status === 'connected';
  const sessionChanged = ready && sessionGenerationRef.current !== null && sessionGenerationRef.current !== session.generation;
  const showError = useCallback((error: unknown) => setToast(errorMessage(error)), []);
  playerRef.current = player; queueRef.current = queue; sessionRef.current = session; pageRef.current = page;

  const applySession = useCallback((snapshot: SessionSnapshot) => { sessionRef.current = snapshot; setSession(snapshot); }, []);
  const applyPlayer = useCallback((snapshot: PlayerState) => setPlayer({ ...defaultPlayer, ...snapshot }), []);
  const changeQueue = useCallback((update: QueueState | ((current: QueueState) => QueueState)) => { const next = typeof update === 'function' ? update(queueRef.current) : update; queueRef.current = next; setQueue(next); }, []);
  const updateDownload = useCallback((task: DownloadTask) => setDownloads(current => [task, ...current.filter(value => value.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt)), []);
  const refreshBootstrap = useCallback(async () => {
    try { const data = await api.bootstrap(); setSettings({ ...defaultSettings, ...data.settings }); applySession(data.session); setDownloads(data.downloads); setHistory(data.history); setTools(data.tools); setBootError(''); setReady(true); }
    catch (error) { setBootError(errorMessage(error)); setReady(true); }
  }, [applySession]);

  useLayoutEffect(() => {
    if (!ready) return;
    if (sessionGenerationRef.current === null) { sessionGenerationRef.current = session.generation; return; }
    if (!sessionChanged) return;
    sessionGenerationRef.current = session.generation; cache.clear(); commentCache.clear(); setCommentSort('top'); changeQueue(emptyQueue()); pendingAdvance.current = null;
    navTrail.current = { pages: [{ kind: 'home' }], index: 0 }; refreshNavigation(value => value + 1);
    setHistory([]); setRecommendations({ items: [], label: 'More to watch' }); setDownloadItem(null); setClearConfirm(false); setAccountMenu(false); setSearchInput(''); setPreviousPage({ kind: 'home' });
    setPage(current => ['playlist', 'channel', 'search'].includes(current.kind) || (current.kind === 'watch' && !localPlayback.current) ? { kind: 'home' } : current);
    if (!localPlayback.current) { const reset = { ...defaultPlayer, volume: playerRef.current.volume, muted: playerRef.current.muted, speed: playerRef.current.speed }; playerRef.current = reset; setPlayer(reset); }
    if (fullscreen) { setFullscreen(false); if (isDesktop) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(false)).catch(showError); }
  }, [session.generation, sessionChanged, ready, cache, commentCache, changeQueue, fullscreen, showError]);

  useEffect(() => {
    if (!isDesktop) return;
    void refreshBootstrap(); let disposed = false; const unsubscribers: (() => void)[] = [];
    const listeners = [api.on<SessionSnapshot>('session-changed', value => { if (!disposed) applySession(value); }), api.on<PlayerState>('player-state', value => { if (!disposed) applyPlayer(value); }), api.on<DownloadTask>('download-updated', value => { if (!disposed) updateDownload(value); }), api.on<PlayerUiRequest>('player-ui-request', request => { if (!disposed && request.loadId === playerRef.current.loadId) nativeRequest.current(request); })];
    for (const promise of listeners) void promise.then(unlisten => { if (disposed) unlisten(); else unsubscribers.push(unlisten); }).catch(showError);
    const interval = setInterval(() => { const generation = sessionRef.current.generation; void api.player().then(value => { if (!disposed && generation === sessionRef.current.generation) applyPlayer(value); }).catch(() => {}); }, 1000);
    return () => { disposed = true; unsubscribers.forEach(unlisten => unlisten()); clearInterval(interval); };
  }, [applyPlayer, applySession, refreshBootstrap, showError, updateDownload]);
  useEffect(() => { if (activeKey && !sessionChanged && ready && isDesktop && !(accountPages.has(page.kind) && !connected)) void cache.ensure(activeKey, page.kind as BrowseKind, page.query ?? '').catch(() => {}); }, [activeKey, cache, connected, page.kind, page.query, ready, sessionChanged]);
  useLayoutEffect(() => { const key = activeKey || page.kind; if (restoredScroll.current === key || (activeKey && !entry?.loaded)) return; restoredScroll.current = key; const position = activeKey ? entry?.scrollY ?? 0 : 0; window.scrollTo({ top: position, behavior: 'instant' }); }, [activeKey, entry?.loaded, entry?.scrollY, page.kind]);
  useEffect(() => {
    if (page.kind !== 'history' || !ready || !isDesktop || sessionChanged) return;
    const generation = session.generation; let cancelled = false;
    void api.bootstrap().then(data => { if (!cancelled && data.session.generation === generation && sessionRef.current.generation === generation) setHistory(data.history); }).catch(error => { if (!cancelled) showError(error); });
    return () => { cancelled = true; };
  }, [page.kind, session.generation, ready, sessionChanged, showError]);
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = settings.theme === 'system' ? media.matches ? 'dark' : 'light' : settings.theme; }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [settings.theme]);
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(''), 6000); return () => clearTimeout(timeout); }, [toast]);
  useEffect(() => { if (!accountMenu) return; accountMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); return () => accountButton.current?.focus(); }, [accountMenu]);

  const navigate = useCallback((next: Page, record = true) => {
    const current = pageRef.current; if (browseKinds.has(current.kind)) cache.saveScroll(browseKey(sessionRef.current.generation, current.kind, current.query), window.scrollY);
    if (fullscreen && next.kind !== 'watch') { setFullscreen(false); if (isDesktop) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(false)).catch(showError); }
    if (next.kind === 'watch') setDocked(false);
    if (record && (current.kind !== next.kind || current.query !== next.query)) { const trail = navTrail.current; trail.pages = [...trail.pages.slice(0, trail.index + 1), next]; trail.index = trail.pages.length - 1; }
    refreshNavigation(value => value + 1);
    pageRef.current = next; setPage(next); setAccountMenu(false);
  }, [cache, fullscreen, showError]);
  function moveNavigation(direction: number) { const trail = navTrail.current; const index = trail.index + direction; if (index < 0 || index >= trail.pages.length) return; trail.index = index; navigate(trail.pages[index], false); }
  const requestPlayback = useCallback((item: MediaItem, startSeconds?: number, playbackMode?: PlaybackMode, showWatch = true) => {
    if (!isDesktop) { showError(new Error('Open Viewsical on your desktop to play videos.')); return; }
    if (showWatch) { if (pageRef.current.kind !== 'watch') setPreviousPage(pageRef.current); navigate({ kind: 'watch' }); }
    localPlayback.current = false; pendingAdvance.current = null; const generation = sessionRef.current.generation;
    const mode = settings.alwaysAudioOnly ? 'audio' : playbackMode ?? playerRef.current.playbackMode;
    setPlayer(current => ({ ...current, video: item, status: 'resolving', error: null, position: startSeconds ?? 0, qualities: [], quality: settings.defaultQuality, playbackMode: mode }));
    void api.playVideo(item, settings.defaultQuality, startSeconds, mode).catch(error => { if (generation !== sessionRef.current.generation) return; showError(error); setPlayer(current => current.video?.id === item.id ? { ...current, status: 'failed', error: errorMessage(error) } : current); });
  }, [navigate, settings.defaultQuality, settings.alwaysAudioOnly, showError]);
  const play = useCallback((item: MediaItem, startSeconds?: number, mode?: PlaybackMode) => {
    const current = queueRef.current; const manual = current.source ? emptyQueue() : current; const id = manual.id || crypto.randomUUID();
    let selected = manual.entries.find(value => value.item.id === item.id); if (!selected) selected = { entryId: `${id}:manual:${crypto.randomUUID()}`, sourceIndex: -1, item };
    changeQueue({ ...manual, id, entries: manual.entries.includes(selected) ? manual.entries : [...manual.entries, selected], selectedEntryId: selected.entryId });
    if (browseKinds.has(pageRef.current.kind) && pageRef.current.kind !== 'playlist') { const source = cache.get(browseKey(sessionRef.current.generation, pageRef.current.kind, pageRef.current.query)); setRecommendations({ items: source?.items.filter(value => value.kind === 'video') ?? [], label: pageRef.current.kind === 'search' ? 'More from your search' : 'More to watch' }); }
    requestPlayback(item, startSeconds, mode);
  }, [cache, changeQueue, requestPlayback]);
  const selectQueue = useCallback((queued: QueueEntry, showWatch = true) => { changeQueue(current => boundMix({ ...current, selectedEntryId: queued.entryId })); requestPlayback(queued.item, undefined, undefined, showWatch); }, [changeQueue, requestPlayback]);
  const loadQueuePage = useCallback((retry = false) => {
    const current = queueRef.current;
    if (!current.source || !current.nextCursor || current.loading || (current.error && !retry)) return;
    const id = current.id; const generation = sessionRef.current.generation; const cursor = current.nextCursor;
    changeQueue(value => ({ ...value, loading: true, error: null }));
    void cache.fetchPage(current.source.key, cursor).then(result => {
      if (queueRef.current.id === id && sessionRef.current.generation === generation && queueRef.current.nextCursor === cursor) changeQueue(value => appendQueuePage(value, result.items.filter(item => item.kind === 'video'), result.nextCursor));
    }).catch(error => { if (queueRef.current.id === id && sessionRef.current.generation === generation) changeQueue(value => ({ ...value, loading: false, error: errorMessage(error) })); });
  }, [cache, changeQueue]);
  const moveQueue = useCallback((direction: number, showWatch = false) => {
    const current = queueRef.current; const selected = current.entries[selectedIndex(current)]; const next = current.entries[selectedIndex(current) + direction];
    const pendingPlaylistItem = direction > 0 && current.nextCursor && (!next || (selected?.sourceIndex >= 0 && next.sourceIndex < 0));
    if (pendingPlaylistItem) { pendingAdvance.current = { queueId: current.id, entryId: current.selectedEntryId }; loadQueuePage(true); setToast('Loading the next video…'); }
    else if (next) selectQueue(next, showWatch);
  }, [loadQueuePage, selectQueue]);
  useEffect(() => { if (needsQueuePage(queue)) loadQueuePage(); }, [queue, loadQueuePage]);
  useEffect(() => { const pending = pendingAdvance.current; const next = queue.entries[selectedIndex(queue) + 1]; if (pending && pending.queueId === queue.id && pending.entryId === queue.selectedEntryId && !queue.loading && !queue.error && next && (next.sourceIndex >= 0 || !queue.nextCursor)) { pendingAdvance.current = null; moveQueue(1); } }, [queue, moveQueue]);
  useEffect(() => { if (player.status === 'ended' && advanceRef.current !== player.loadId) { advanceRef.current = player.loadId; moveQueue(1); } }, [player.status, player.loadId, moveQueue]);
  const action = useCallback((name: PlayerAction, value?: number) => { const request = name === 'adjust-volume' ? api.overlayAction(playerRef.current.loadId, name, value) : api.playerAction(name, value); void request.catch(showError); }, [showError]);
  const changeMode = useCallback((mode: PlaybackMode) => { void api.setPlaybackMode(mode).catch(showError); }, [showError]);
  const toggleFullscreen = useCallback(() => { if (pageRef.current.kind !== 'watch') navigate({ kind: 'watch' }); const next = !fullscreen; setFullscreen(next); if (isDesktop) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(next)).catch(showError); }, [fullscreen, navigate, showError]);
  const toggleTheater = useCallback(() => { if (pageRef.current.kind !== 'watch') navigate({ kind: 'watch' }); setTheater(value => !value); }, [navigate]);
  nativeRequest.current = request => { if (request.action === 'next') moveQueue(1); else if (request.action === 'previous') moveQueue(-1); else if (request.action === 'fullscreen') toggleFullscreen(); else if (request.action === 'theater') toggleTheater(); else if (request.action === 'scroll') { if (!fullscreen && Number.isFinite(request.value)) window.scrollBy({ top: request.value, behavior: 'instant' }); } else { if (pageRef.current.kind !== 'watch') navigate({ kind: 'watch' }); setFocusSignal(value => value + 1); } };
  const queueIndex = selectedIndex(queue); const hasPrevious = queueIndex > 0; const hasNext = queueIndex >= 0 && (queueIndex < queue.entries.length - 1 || !!queue.nextCursor); const mini = page.kind !== 'watch';
  useEffect(() => { if (isDesktop) void api.playerUiContext({ hasPrevious, hasNext, mini, theater, fullscreen }).catch(() => {}); }, [hasPrevious, hasNext, mini, theater, fullscreen, player.loadId]);
  usePlayerShortcuts({ player, blocked: !!downloadItem || signInOpen || accountMenu || clearConfirm, fullscreen, onAction: action, onFullscreen: toggleFullscreen });
  useEffect(() => {
    function searchKey(event: KeyboardEvent) {
      if (!event.defaultPrevented && !downloadItem && !signInOpen && !accountMenu && !clearConfirm && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); }
    }
    window.addEventListener('keydown', searchKey); return () => window.removeEventListener('keydown', searchKey);
  }, [accountMenu, clearConfirm, downloadItem, signInOpen]);
  function startPlaylist(index: number, mode?: PlaybackMode) { if (!entry) return; const values = entry.items.filter(item => item.kind === 'video'); const source = { key: activeKey, query: page.query ?? '', collection: entry.collection ?? page.collection ?? null }; const next = playlistQueue(crypto.randomUUID(), values, index, source, entry.nextCursor); changeQueue(next); if (next.entries[index]) requestPlayback(next.entries[index].item, undefined, mode); }
  function addToQueue(item: MediaItem) { changeQueue(current => { const id = current.id || crypto.randomUUID(); return { ...current, id, entries: [...current.entries, { entryId: `${id}:manual:${crypto.randomUUID()}`, sourceIndex: -1, item }] }; }); setToast('Added to queue'); }
  function activate(item: MediaItem) { if (item.kind === 'playlist') { const collection: CollectionSummary = { id: item.id, title: item.title, owner: item.channel, thumbnail: item.thumbnail, itemCount: null, description: item.description, isMix: item.id.startsWith('RD'), url: item.url }; navigate({ kind: 'playlist', query: item.url || item.id, title: item.title, collection }); } else if (item.kind === 'channel') navigate({ kind: 'channel', query: item.url || item.id, title: item.title }); else play(item); }
  function submitSearch(event: FormEvent) { event.preventDefault(); const query = searchInput.trim(); if (!query) { searchRef.current?.focus(); return; } if (!isDesktop) { showError(new Error('Search is available in the Viewsical desktop app.')); return; } try { const url = new URL(query); if (/^(www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/.test(url.hostname) && url.searchParams.get('list')) { navigate({ kind: 'playlist', query }); return; } } catch { /* Free text is a regular search. */ } navigate({ kind: 'search', query }); }
  function refreshPage() { if (activeKey) void cache.refresh(activeKey, page.kind as BrowseKind, page.query ?? '').catch(() => {}); }
  function playDownloaded(task: DownloadTask) { setPreviousPage({ kind: 'downloads' }); navigate({ kind: 'watch' }); localPlayback.current = true; changeQueue(emptyQueue()); setPlayer(current => ({ ...current, video: task.video, status: 'resolving', error: null, position: 0, playbackMode: settings.alwaysAudioOnly || task.mode === 'audio' ? 'audio' : playerRef.current.playbackMode })); void api.playLocal(task.id).catch(error => { showError(error); setPlayer(current => ({ ...current, status: 'failed', error: errorMessage(error) })); }); }
  function closePlayer() { pendingAdvance.current = null; changeQueue(emptyQueue()); action('stop'); }
  async function openSignIn() { setAccountMenu(false); setSignInOpen(true); setSignInError(''); setSignInBusy(true); try { await api.openSignIn(); } catch (error) { setSignInError(errorMessage(error)); } finally { setSignInBusy(false); } }
  async function completeSignIn() { setSignInBusy(true); setSignInError(''); try { const result = await api.completeSignIn(); applySession(result); if (result.status === 'connected') { setSignInOpen(false); setToast('YouTube account connected'); } else setSignInError(result.message || 'Finish signing in to YouTube, then try again.'); } catch (error) { setSignInError(errorMessage(error)); } finally { setSignInBusy(false); } }
  async function signOut() { setAccountMenu(false); try { await api.signOut(); applySession(await api.session()); setToast('Signed out of Viewsical'); return true; } catch (error) { showError(error); return false; } }
  async function saveSettings(next: typeof settings) { if (playerRef.current.video) next = { ...next, volume: playerRef.current.volume, muted: playerRef.current.muted }; const previous = settings; setSettings(next); try { const saved = await api.saveSettings(next); setSettings(saved); if (saved.alwaysAudioOnly && !previous.alwaysAudioOnly && playerRef.current.video && playerRef.current.playbackMode !== 'audio') changeMode('audio'); } catch (error) { setSettings(previous); showError(error); } }
  function accountKeys(event: ReactKeyboardEvent<HTMLDivElement>) { const buttons = Array.from(accountMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAccountMenu(false); } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); } else if (event.key === 'Tab' && buttons.length && ((event.shiftKey && index === 0) || (!event.shiftKey && index === buttons.length - 1))) { event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus(); } }
  const missingTools = tools.filter(tool => !tool.available);
  const navItems: { kind: Page['kind']; label: string; icon: LucideIcon; count?: number }[] = [{ kind: 'home', label: 'Home', icon: Home }, { kind: 'subscriptions', label: 'Subscriptions', icon: Users }, { kind: 'playlists', label: 'Playlists', icon: ListVideo }, { kind: 'downloads', label: 'Downloads', icon: ArrowDownToLine, count: downloads.filter(task => activeDownloads.has(task.status)).length }, { kind: 'history', label: 'History', icon: History }];
  const titles: Record<string, string> = { home: 'Home', subscriptions: 'Subscriptions', channels: 'Subscriptions', playlists: 'Your playlists', downloads: 'Downloads', history: 'History', settings: 'Settings', search: 'Search results' };
  const loading = !!entry?.loading; const initialLoading = !ready || !entry || (entry.loading && !entry.loaded); const blocked = !!downloadItem || signInOpen || accountMenu || clearConfirm;

  function browseContent() {
    if (!isDesktop) return <EmptyState icon={Monitor} title="Made for your desktop">Open the Viewsical Windows app to search YouTube, play videos, and build your offline library.<div className="desktop-note"><ShieldCheck size={17} />Your sign-in and library stay on your computer.</div></EmptyState>;
    if (accountPages.has(page.kind) && !connected) return <EmptyState icon={page.kind === 'playlists' ? ListVideo : Users} title={page.kind === 'playlists' ? 'Your playlists, all together' : 'Keep up with your subscriptions'} action={<button className="sign-in-button" onClick={() => void openSignIn()}><UserCircle size={20} />Sign in to YouTube</button>}>Connect your YouTube account to see {page.kind === 'playlists' ? 'your saved playlists' : 'the channels you follow and their latest videos'}.{['blocked', 'expired'].includes(session.status) && <p className="account-error">{session.message}</p>}</EmptyState>;
    if (initialLoading) return <Skeletons rows={page.kind === 'search' || page.kind === 'playlist'} />;
    if (entry?.error && !items.length) return <EmptyState icon={AlertCircle} title="Couldn’t load videos" action={<button className="button secondary" onClick={refreshPage}><RefreshCw size={17} />Try again</button>}>{entry.error}</EmptyState>;
    if (!items.length) return <EmptyState icon={page.kind === 'search' ? Search : ListVideo} title={page.kind === 'search' ? 'No results found' : page.kind === 'home' ? 'Find your next watch' : 'Nothing here yet'} action={page.kind === 'home' ? <button className="button secondary" onClick={() => searchRef.current?.focus()}><Search size={18} />Search YouTube</button> : undefined}>{page.kind === 'search' ? 'Try different words or paste a YouTube video link.' : page.kind === 'home' ? 'Search for a video, paste a YouTube link, or connect your account for your personal feed.' : 'Refresh to check for videos, or try another collection.'}</EmptyState>;
    return <>{entry?.error && <div className="inline-error"><AlertCircle size={18} /><span>{entry.error}</span><button className="text-link" onClick={() => void cache.loadMore(activeKey).catch(() => {})}>Retry</button></div>}{page.kind === 'playlist' && entry ? <PlaylistView entry={entry} fallback={page.collection} queue={queue} onStart={startPlaylist} onDownload={setDownloadItem} onMore={() => void cache.loadMore(activeKey).catch(() => {})} /> : <><div className={page.kind === 'search' ? 'result-list' : 'video-grid'}>{items.map(item => <VideoCard key={item.id} item={item} onActivate={activate} onDownload={setDownloadItem} onQueue={addToQueue} row={page.kind === 'search'} />)}</div>{entry?.nextCursor && <ScrollLoader key={activeKey} scope={activeKey} cursor={entry.nextCursor} loading={entry.loadingMore || entry.loading} error={entry.error} onLoad={() => void cache.loadMore(activeKey).catch(() => {})} />}</>}</>;
  }
  return <div className={`app ${sidebar ? '' : 'sidebar-compact'} ${fullscreen ? 'player-fullscreen' : ''} ${theater ? 'theater-mode' : ''} ${player.video && mini ? docked ? 'has-bottom-player' : 'has-mini-player' : ''}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="topbar" data-tauri-drag-region><div className="topbar-brand" data-tauri-drag-region><IconButton label={sidebar ? 'Collapse navigation' : 'Expand navigation'} onClick={() => setSidebar(value => !value)}><Menu size={23} /></IconButton><button className="logo-button" onClick={() => navigate({ kind: 'home' })}><Logo /></button><IconButton label="Go back" disabled={navTrail.current.index === 0} onClick={() => moveNavigation(-1)}><ChevronLeft size={23} /></IconButton><IconButton label="Go forward" disabled={navTrail.current.index >= navTrail.current.pages.length - 1} onClick={() => moveNavigation(1)}><ChevronRight size={23} /></IconButton></div>
      <div className="header-center"><IconButton label="Go to Home" className="header-home" onClick={() => navigate({ kind: 'home' })}><Home size={23} fill="currentColor" /></IconButton><form className="search-form" onSubmit={submitSearch}><div className="search-input-wrap"><Search className="search-leading" size={20} /><label className="sr-only" htmlFor="search">Search YouTube or paste a video link</label><input ref={searchRef} id="search" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Search or paste a YouTube link" autoComplete="off" spellCheck="false" />{searchInput && <IconButton label="Clear search" className="clear-search" onClick={() => { setSearchInput(''); searchRef.current?.focus(); }}><X size={19} /></IconButton>}</div><button className="search-submit" aria-label="Search" title="Search"><Search size={23} /></button></form></div>
      <div className="header-actions" data-tauri-drag-region><div className="header-drag-gap" data-tauri-drag-region />{!isDesktop && <span className="preview-label"><Monitor size={15} /> Preview</span>}{player.video && page.kind !== 'watch' && <IconButton label="Return to player" onClick={() => navigate({ kind: 'watch' })}><Video size={22} /></IconButton>}
        <button ref={accountButton} className={connected ? 'account-avatar connected-avatar' : 'sign-in-button'} aria-label={connected ? 'Connected account' : 'Account sign-in'} title={connected ? 'Signed in to YouTube' : 'Sign in'} aria-haspopup="menu" aria-expanded={accountMenu} onClick={() => setAccountMenu(value => !value)}>{connected ? <Check size={22} strokeWidth={2.7} /> : <><UserCircle size={21} /><span>Sign in</span></>}</button>
        {accountMenu && <><button className="menu-dismiss" tabIndex={-1} aria-label="Close account menu" onClick={() => setAccountMenu(false)} /><div ref={accountMenuRef} className="account-menu" role="menu" onKeyDown={accountKeys}><div className="account-menu-heading">{connected ? <ShieldCheck size={30} /> : <UserCircle size={30} />}<div><strong>{connected ? session.label || 'YouTube account' : 'Your YouTube account'}</strong><span>{connected ? 'Connected to Viewsical' : 'Browse your subscriptions and playlists'}</span></div></div><button role="menuitem" onClick={() => void openSignIn()}><UserCircle size={19} />{connected ? 'Manage sign-in' : 'Sign in to YouTube'}</button><button role="menuitem" onClick={() => navigate({ kind: 'settings' })}><Settings size={19} />Settings</button>{connected && <button role="menuitem" onClick={() => void signOut()}><LogOut size={19} />Sign out</button>}</div></>}
        <WindowControls onError={showError} />
      </div>
    </header>

    <aside className="sidebar" aria-label="Main navigation"><nav>{navItems.map(({ kind, label, icon: Icon, count }) => <button key={kind} className={`nav-item ${(page.kind === kind || (kind === 'subscriptions' && page.kind === 'channels') || (kind === 'playlists' && page.kind === 'playlist')) ? 'active' : ''}`} title={!sidebar ? label : undefined} aria-current={page.kind === kind ? 'page' : undefined} onClick={() => navigate({ kind })}><Icon size={22} strokeWidth={page.kind === kind ? 2 : 1.65} /><span>{label}</span>{!!count && <span className="nav-count">{count}</span>}</button>)}</nav>
      <div className="sidebar-rule" />
      {sidebar && <div className="sidebar-library"><div className="sidebar-section-label">Your library</div><button className={`nav-item ${page.kind === 'watch' ? 'active' : ''}`} disabled={!player.video} onClick={() => navigate({ kind: 'watch' })}><Video size={22} strokeWidth={1.65} /><span>Now playing</span>{player.status === 'playing' && <span className="playing-bars"><i /><i /><i /></span>}</button>{queue.entries.length > 0 && <div className="queue-count">{queue.entries.length} {queue.entries.length === 1 ? 'video' : 'videos'} in your queue</div>}</div>}
      {!connected && sidebar && <div className="sidebar-signin"><p>Bring your subscriptions and playlists with you.</p><button className="sign-in-button" onClick={() => void openSignIn()}><UserCircle size={20} />Sign in</button></div>}
      <div className="sidebar-bottom"><button className={`nav-item ${page.kind === 'settings' ? 'active' : ''}`} title={!sidebar ? 'Settings' : undefined} onClick={() => navigate({ kind: 'settings' })}><Settings size={22} strokeWidth={1.65} /><span>Settings</span></button>{sidebar && <p>Viewsical <span>0.1.5</span><br /><small>Your library stays on this device.</small></p>}</div>
    </aside>
    <main id="main-content" className={`main-content ${page.kind === 'watch' ? 'watch-content' : ''}`}>
      {bootError && <div className="banner error-banner" role="alert"><AlertCircle size={20} /><div><strong>Viewsical couldn’t finish starting</strong><p>{bootError}</p></div><button className="button secondary small" onClick={() => void refreshBootstrap()}>Retry</button></div>}
      {missingTools.length > 0 && page.kind !== 'settings' && <div className="banner"><SlidersHorizontal size={20} /><div><strong>Media tools need setup</strong><p>Some playback or download tools are missing.</p></div><button className="button secondary small" onClick={() => navigate({ kind: 'settings' })}>View settings</button></div>}
      <div className={page.kind === 'watch' ? 'watch-layout' : 'page-layout'}><div className={page.kind === 'watch' ? 'watch-main' : 'route-body'}>
        {page.kind === 'watch' && <div className="watch-topline" key="watch-topline"><button className="back-button" onClick={() => navigate(previousPage)}><ArrowLeft size={18} />Back</button><span className="watch-source"><span className={player.status === 'playing' ? 'status-dot active' : 'status-dot'} />{player.status === 'resolving' ? 'Preparing video' : player.status === 'playing' ? 'Now playing' : player.status === 'paused' ? 'Paused' : 'Video player'}</span></div>}
        <PlayerHost key="persistent-player" player={player} mini={mini} docked={mini && docked} onDock={() => setDocked(true)} onUndock={() => setDocked(false)} fullscreen={fullscreen} theater={theater} blocked={blocked} hasPrevious={hasPrevious} hasNext={hasNext} focusSignal={focusSignal} onAction={action} onMode={changeMode} onPrevious={() => moveQueue(-1)} onNext={() => moveQueue(1)} onFullscreen={toggleFullscreen} onTheater={toggleTheater} onExpand={() => navigate({ kind: 'watch' })} onClose={closePlayer} onRetry={() => { if (player.video) requestPlayback(player.video, player.status === 'ended' ? 0 : player.position); }} />
        {page.kind === 'watch' ? player.video ? <><WatchInfo video={player.video} onQueue={addToQueue} onDownload={setDownloadItem} /><CommentsPanel videoId={player.video.id} generation={session.generation} cache={commentCache} sort={commentSort} onSort={setCommentSort} /></> : <EmptyState icon={Video} title="Nothing is playing yet" action={<button className="button primary" onClick={() => navigate({ kind: 'home' })}>Find a video</button>}>Search for a video or open one from your downloads.</EmptyState> : <div key="browse-content">
          <div className="page-heading"><div>{['playlist', 'channel'].includes(page.kind) && <button className="back-button" onClick={() => navigate({ kind: page.kind === 'playlist' ? 'playlists' : 'subscriptions' })}><ArrowLeft size={17} />Back</button>}<h1>{page.kind === 'playlist' ? 'Playlist' : page.title || titles[page.kind] || 'Videos'}{page.kind === 'search' && <span className="query-subtitle">{page.query}</span>}</h1>{page.kind === 'downloads' && <p>Ready to watch, even when you’re offline.</p>}{page.kind === 'history' && <p>Your watch history is saved on this device.</p>}</div><div className="heading-actions">{browseKinds.has(page.kind) && <IconButton label="Refresh videos" disabled={loading} onClick={refreshPage}><RefreshCw size={19} className={loading ? 'spin' : ''} /></IconButton>}{page.kind === 'history' && history.length > 0 && <button className="button secondary small" onClick={() => setClearConfirm(true)}><Trash2 size={16} />Clear history</button>}</div></div>
          {['subscriptions', 'channels'].includes(page.kind) && <div className="page-tabs" aria-label="Subscription view"><button className={page.kind === 'subscriptions' ? 'selected' : ''} aria-pressed={page.kind === 'subscriptions'} onClick={() => navigate({ kind: 'subscriptions' })}>Latest videos</button><button className={page.kind === 'channels' ? 'selected' : ''} aria-pressed={page.kind === 'channels'} onClick={() => navigate({ kind: 'channels' })}>Channels</button></div>}
          {browseKinds.has(page.kind) && browseContent()}
          {page.kind === 'downloads' && <DownloadsPanel tasks={downloads} onPlay={playDownloaded} onDownload={setDownloadItem} onSearch={() => searchRef.current?.focus()} onError={showError} />}
          {page.kind === 'history' && <HistoryPanel entries={history} onPlay={play} onDownload={setDownloadItem} />}
          {page.kind === 'settings' && <SettingsPanel settings={settings} session={session} tools={tools} onSave={next => void saveSettings(next)} onSignIn={() => void openSignIn()} onSignOut={signOut} onClearHistory={() => setClearConfirm(true)} onError={showError} />}
        </div>}
      </div>{page.kind === 'watch' && player.video && <aside className="watch-aside"><QueuePanel queue={queue} onSelect={selectQueue} onRemove={id => changeQueue(current => ({ ...current, entries: current.entries.filter(value => value.entryId !== id) }))} onClear={() => { const selected = queue.entries.find(value => value.entryId === queue.selectedEntryId); changeQueue({ ...emptyQueue(), id: crypto.randomUUID(), entries: selected ? [selected] : [], selectedEntryId: selected?.entryId ?? null }); }} onMore={() => loadQueuePage()} onRetry={() => loadQueuePage(true)} />{!queue.source && recommendations.items.filter(item => item.id !== player.video?.id).length > 0 && <section className="recommendations"><h2>{recommendations.label}</h2>{recommendations.items.filter(item => item.id !== player.video?.id).slice(0, 8).map(item => <div className="recommendation" key={item.id}><button className="recommendation-main" onClick={() => play(item)}><Thumbnail item={item} /><span><strong>{item.title}</strong><small>{item.channel}</small><small>{views(item.viewCount)}</small></span></button><IconButton label={`Add ${item.title} to queue`} onClick={() => addToQueue(item)}><Plus size={17} /></IconButton></div>)}</section>}</aside>}</div>
    </main>
    {downloadItem && <DownloadDialog item={downloadItem} settings={settings} player={player} onClose={() => setDownloadItem(null)} onAdded={task => { updateDownload(task); setToast('Download added'); }} onError={showError} />}
    {signInOpen && <Modal title="Sign in to YouTube" onClose={() => setSignInOpen(false)}><div className="signin-illustration"><UserCircle size={43} strokeWidth={1.4} /><span className="signin-connector" /><span className="brand-mark"><Play size={19} fill="currentColor" strokeWidth={0} /></span></div><p className="modal-intro">Finish signing in in the YouTube window, then return here to connect your account.</p><div className="info-note"><ShieldCheck size={20} /><p>Your session is managed on this computer. Viewsical does not ask for or store your Google password.</p></div><div className="signin-warning"><AlertCircle size={18} /><p>Google may block sign-in in embedded browsers. If that happens, account features will be unavailable. You can still search, play, and download public videos.</p></div>{(signInError || session.status === 'blocked') && <div className="inline-error" role="alert"><AlertCircle size={18} /><span>{signInError || session.message}</span></div>}<button className="text-link reopen-link" disabled={signInBusy} onClick={() => void openSignIn()}><ExternalLink size={16} />Reopen YouTube sign-in</button><div className="modal-footer"><button className="button secondary" onClick={() => setSignInOpen(false)}>Continue without account</button><button className="button primary" disabled={signInBusy} onClick={() => void completeSignIn()}>{signInBusy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}{signInBusy ? 'Checking…' : 'I have signed in'}</button></div></Modal>}
    {clearConfirm && <Modal title="Clear watch history?" onClose={() => setClearConfirm(false)}><p className="modal-intro">This removes your local watch history and saved playback positions from Viewsical. Your downloaded files and YouTube account are unaffected.</p><div className="modal-footer"><button className="button secondary" onClick={() => setClearConfirm(false)}>Keep history</button><button className="button primary" onClick={() => { void api.clearHistory().then(() => { setHistory([]); setClearConfirm(false); setToast('Watch history cleared'); }).catch(showError); }}>Clear history</button></div></Modal>}
    {toast && <div className="toast" role="status"><span>{toast}</span><IconButton label="Dismiss message" onClick={() => setToast('')}><X size={17} /></IconButton></div>}
    {!isDesktop && <div className="preview-status"><Monitor size={14} /> Desktop preview · app features need the Windows app</div>}
  </div>;
}
