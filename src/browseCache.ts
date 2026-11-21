import type { BrowseKind, BrowsePage, ChannelSummary, CollectionSummary, MediaItem } from './types';
import { errorMessage, uniqueItems } from './format';

export interface BrowseEntry {
  key: string; kind: BrowseKind; query: string; items: MediaItem[]; nextCursor: string | null;
  collection: CollectionSummary | null; attempted: boolean; loaded: boolean;
  channel?: ChannelSummary;
  loading: boolean; loadingMore: boolean; error: string | null; scrollY: number;
}
type Fetcher = (kind: BrowseKind, query: string, cursor: string | null, requestId: string) => Promise<BrowsePage>;
interface RecordEntry { entry: BrowseEntry; pages: Map<string, BrowsePage>; jobs: Map<string, { id: string; promise: Promise<BrowsePage> }>; revision: number }

export function browseKey(generation: number, kind: string, query = ''): string { return JSON.stringify([generation, kind, query.trim()]); }
export function mergeBrowseItems(kind: BrowseKind, previous: MediaItem[], next: MediaItem[]): MediaItem[] {
  return kind === 'playlist' ? [...previous, ...next] : uniqueItems([...previous, ...next]);
}

/** Session-only metadata cache. No timers or navigation-based invalidation. */
export class BrowseCache {
  private records = new Map<string, RecordEntry>();
  private listeners = new Set<() => void>();
  constructor(private fetcher: Fetcher, private cancel: (id: string) => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (key: string): BrowseEntry | undefined => this.records.get(key)?.entry;
  private publish(record: RecordEntry, update: Partial<BrowseEntry>) { record.entry = { ...record.entry, ...update }; this.listeners.forEach(listener => listener()); }
  private create(key: string, kind: BrowseKind, query: string): RecordEntry {
    const record: RecordEntry = { entry: { key, kind, query, items: [], nextCursor: null, collection: null, attempted: false, loaded: false, loading: false, loadingMore: false, error: null, scrollY: 0 }, pages: new Map(), jobs: new Map(), revision: 0 };
    this.records.set(key, record); return record;
  }
  async ensure(key: string, kind: BrowseKind, query: string): Promise<void> {
    const record = this.records.get(key) ?? this.create(key, kind, query);
    if (record.entry.attempted) return;
    await this.fetchPage(key, null);
  }
  async refresh(key: string, kind: BrowseKind, query: string): Promise<void> {
    const record = this.records.get(key) ?? this.create(key, kind, query);
    record.revision += 1; record.jobs.forEach(job => this.cancel(job.id)); record.jobs.clear(); record.pages.clear();
    await this.fetchPage(key, null);
  }
  saveScroll(key: string, scrollY: number) { const record = this.records.get(key); if (record && record.entry.scrollY !== scrollY) this.publish(record, { scrollY }); }
  invalidate(key: string) {
    const record = this.records.get(key);
    if (!record) return;
    this.records.delete(key);
    record.jobs.forEach(job => this.cancel(job.id));
    this.listeners.forEach(listener => listener());
  }
  clear() { this.records.forEach(record => { record.revision += 1; record.jobs.forEach(job => this.cancel(job.id)); }); this.records.clear(); this.listeners.forEach(listener => listener()); }
  async loadMore(key: string): Promise<BrowsePage | null> {
    const record = this.records.get(key);
    if (!record?.entry.nextCursor) return null;
    return this.fetchPage(key, record.entry.nextCursor);
  }
  fetchPage(key: string, cursor: string | null): Promise<BrowsePage> {
    const record = this.records.get(key);
    if (!record) return Promise.reject(new Error('This collection is no longer available. Open it again.'));
    const pageKey = cursor ?? '';
    const cached = record.pages.get(pageKey); if (cached) return Promise.resolve(cached);
    const pending = record.jobs.get(pageKey); if (pending) return pending.promise;
    if (cursor !== null && cursor !== record.entry.nextCursor) return Promise.reject(new Error('The playlist changed while loading. Open the playlist again.'));
    const revision = record.revision;
    const id = crypto.randomUUID();
    this.publish(record, { attempted: true, loading: cursor === null, loadingMore: cursor !== null, error: null });
    const promise = this.fetcher(record.entry.kind, record.entry.query, cursor, id).then(page => {
      if (this.records.get(key) !== record || record.revision !== revision) throw new Error('The collection request was replaced.');
      record.pages.set(pageKey, page);
      const collection = page.collection ?? record.entry.collection;
      let items = cursor === null ? mergeBrowseItems(record.entry.kind, [], page.items) : mergeBrowseItems(record.entry.kind, record.entry.items, page.items);
      if (collection?.isMix && items.length > 96) { items = items.slice(-96); while (record.pages.size > 4) record.pages.delete(record.pages.keys().next().value!); }
      this.publish(record, { items, nextCursor: page.nextCursor, collection, channel: page.channel ?? record.entry.channel, loaded: true, loading: false, loadingMore: false, error: null });
      return page;
    }).catch(error => {
      if (this.records.get(key) === record && record.revision === revision) this.publish(record, { loading: false, loadingMore: false, error: errorMessage(error) });
      throw error;
    }).finally(() => { if (record.jobs.get(pageKey)?.id === id) record.jobs.delete(pageKey); });
    record.jobs.set(pageKey, { id, promise }); return promise;
  }
}
