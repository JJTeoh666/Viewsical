import type { CollectionSummary, MediaItem } from './types';

export interface QueueEntry { entryId: string; sourceIndex: number; item: MediaItem }
export interface QueueSource { key: string; query: string; collection: CollectionSummary | null }
export interface QueueState { id: string; entries: QueueEntry[]; selectedEntryId: string | null; source: QueueSource | null; nextCursor: string | null; loading: boolean; complete: boolean; error: string | null; nextOrdinal: number; isMix: boolean }
export const emptyQueue = (): QueueState => ({ id: '', entries: [], selectedEntryId: null, source: null, nextCursor: null, loading: false, complete: true, error: null, nextOrdinal: 0, isMix: false });

export function queueEntries(id: string, items: MediaItem[], offset = 0): QueueEntry[] {
  return items.map((item, index) => ({ entryId: `${id}:${offset + index}`, sourceIndex: item.playlistIndex ?? offset + index + 1, item }));
}
export function playlistQueue(id: string, items: MediaItem[], selected: number, source: QueueSource, nextCursor: string | null): QueueState {
  const entries = queueEntries(id, items);
  return { id, entries, selectedEntryId: entries[selected]?.entryId ?? entries[0]?.entryId ?? null, source, nextCursor, loading: false, complete: nextCursor === null, error: null, nextOrdinal: items.length, isMix: source.collection?.isMix ?? false };
}
export function appendQueuePage(queue: QueueState, items: MediaItem[], nextCursor: string | null): QueueState {
  const playlist = queue.entries.filter(entry => entry.sourceIndex >= 0);
  const manuallyAdded = queue.entries.filter(entry => entry.sourceIndex < 0);
  return boundMix({ ...queue, entries: [...playlist, ...queueEntries(queue.id, items, queue.nextOrdinal), ...manuallyAdded], nextOrdinal: queue.nextOrdinal + items.length, nextCursor, complete: nextCursor === null, loading: false, error: null });
}
export function boundMix(queue: QueueState): QueueState {
  if (!queue.isMix) return queue;
  const index = queue.entries.findIndex(entry => entry.entryId === queue.selectedEntryId);
  return index > 24 ? { ...queue, entries: queue.entries.slice(index - 24) } : queue;
}
export function selectedIndex(queue: QueueState): number { return queue.entries.findIndex(entry => entry.entryId === queue.selectedEntryId); }
export function needsQueuePage(queue: QueueState): boolean {
  const index = selectedIndex(queue);
  const upcoming = queue.entries.slice(index + 1).filter(entry => entry.sourceIndex >= 0).length;
  return index >= 0 && !!queue.source && !!queue.nextCursor && !queue.loading && !queue.error && upcoming < 2;
}
