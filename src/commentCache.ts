import { errorMessage } from './format';
import type { CommentPage, CommentSort, VideoComment } from './types';

export interface CommentEntry {
  key: string; videoId: string; sort: CommentSort; items: VideoComment[];
  nextCursor: string | null; totalCount: number | null; disabled: boolean; limited: boolean;
  attempted: boolean; loaded: boolean; loading: boolean; loadingMore: boolean; error: string | null; errorCode: string | null;
}
type Fetcher = (videoId: string, cursor: string | null, sort: CommentSort, requestId: string) => Promise<CommentPage>;
interface RecordEntry { entry: CommentEntry; revision: number; touched: number; failedCursor?: string | null; pending?: { id: string; promise: Promise<void> } }
export const COMMENT_LIMIT = 300;
export function commentKey(generation: number, videoId: string, sort: CommentSort): string { return JSON.stringify([generation, videoId, sort]); }

/** Only completed comment data survives navigation; stale workers never publish. */
export class CommentCache {
  private records = new Map<string, RecordEntry>();
  private listeners = new Set<() => void>();
  private activeKey: string | null = null;
  private clock = 0;
  constructor(private fetcher: Fetcher, private cancel: (id: string) => void, private maxEntries = 12) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (key: string): CommentEntry | undefined => this.records.get(key)?.entry;
  private publish(record: RecordEntry, update: Partial<CommentEntry>) { record.entry = { ...record.entry, ...update }; this.listeners.forEach(listener => listener()); }
  private stop(record: RecordEntry) {
    if (!record.pending) return;
    record.revision += 1; this.cancel(record.pending.id); record.pending = undefined;
    this.publish(record, { loading: false, loadingMore: false, attempted: record.entry.loaded });
  }
  activate(key: string | null) {
    this.activeKey = key;
    this.records.forEach((record, candidate) => { if (candidate !== key) this.stop(record); });
    const active = key ? this.records.get(key) : undefined; if (active) active.touched = ++this.clock;
  }
  clear() { this.records.forEach(record => { record.revision += 1; if (record.pending) this.cancel(record.pending.id); }); this.records.clear(); this.activeKey = null; this.listeners.forEach(listener => listener()); }
  private create(key: string, videoId: string, sort: CommentSort): RecordEntry {
    while (this.records.size >= this.maxEntries) {
      const oldest = [...this.records].filter(([candidate]) => candidate !== this.activeKey).sort(([, a], [, b]) => a.touched - b.touched)[0];
      if (!oldest) break;
      this.stop(oldest[1]); this.records.delete(oldest[0]);
    }
    const record: RecordEntry = { revision: 0, touched: ++this.clock, entry: { key, videoId, sort, items: [], nextCursor: null, totalCount: null, disabled: false, limited: false, attempted: false, loaded: false, loading: false, loadingMore: false, error: null, errorCode: null } };
    this.records.set(key, record); return record;
  }
  async ensure(key: string, videoId: string, sort: CommentSort) {
    const record = this.records.get(key) ?? this.create(key, videoId, sort); record.touched = ++this.clock;
    if (record.entry.attempted) return;
    await this.load(record, null);
  }
  async refresh(key: string, videoId: string, sort: CommentSort) {
    const record = this.records.get(key) ?? this.create(key, videoId, sort); this.stop(record); record.revision += 1; record.touched = ++this.clock;
    await this.load(record, null);
  }
  async loadMore(key: string) {
    const record = this.records.get(key);
    if (!record?.entry.nextCursor || record.entry.limited || record.entry.items.length >= COMMENT_LIMIT) return;
    await this.load(record, record.entry.nextCursor);
  }
  async retry(key: string) { const record = this.records.get(key); if (record) await this.load(record, record.failedCursor ?? null); }
  private load(record: RecordEntry, cursor: string | null): Promise<void> {
    if (record.pending) return record.pending.promise;
    const revision = record.revision; const id = crypto.randomUUID(); record.failedCursor = undefined;
    this.publish(record, { attempted: true, loading: cursor === null, loadingMore: cursor !== null, error: null, errorCode: null });
    const promise = this.fetcher(record.entry.videoId, cursor, record.entry.sort, id).then(page => {
      if (record.revision !== revision || this.records.get(record.entry.key) !== record) return;
      if (page.videoId !== record.entry.videoId || page.sort !== record.entry.sort) throw new Error('Comments changed while loading. Please refresh.');
      const items = cursor === null ? [] : [...record.entry.items]; const seen = new Set(items.map(item => item.id));
      for (const item of page.items) if (!seen.has(item.id)) { items.push(item); seen.add(item.id); }
      const limited = !!page.limited || items.length >= COMMENT_LIMIT;
      this.publish(record, { items: items.slice(0, COMMENT_LIMIT), nextCursor: limited ? null : page.nextCursor, totalCount: page.totalCount, disabled: page.disabled, limited, loaded: true, loading: false, loadingMore: false, error: null, errorCode: null });
    }).catch(error => {
      if (record.revision !== revision || this.records.get(record.entry.key) !== record) return;
      record.failedCursor = cursor;
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
      this.publish(record, { loading: false, loadingMore: false, error: errorMessage(error), errorCode: code });
    }).finally(() => { if (record.pending?.id === id) record.pending = undefined; });
    record.pending = { id, promise }; return promise;
  }
}
