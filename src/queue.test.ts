import { describe, expect, it } from 'vitest';
import { appendQueuePage, boundMix, needsQueuePage, playlistQueue, selectedIndex } from './queue';
import type { MediaItem } from './types';
const item = (id: string, index: number): MediaItem => ({ id, playlistIndex: index, kind: 'video', title: id, channel: '', thumbnail: null, url: '', duration: null, viewCount: null, description: null });
describe('playlist queue', () => {
  it('starts the clicked occurrence and preserves repeated IDs across continuation pages', () => {
    const queue = playlistQueue('queue', [item('same', 1), item('different', 2), item('same', 3)], 2, { key: 'playlist', query: 'PLtest', collection: null }, 'next');
    expect(selectedIndex(queue)).toBe(2); expect(queue.entries[0].entryId).not.toBe(queue.entries[2].entryId);
    const full = appendQueuePage(queue, [item('same', 4)], null);
    expect(full.entries).toHaveLength(4); expect(full.selectedEntryId).toBe(queue.selectedEntryId); expect(full.complete).toBe(true);
  });
  it('loads finite queues only near playback exhaustion and stops after one page', () => {
    const first = playlistQueue('finite', Array.from({ length: 24 }, (_, index) => item('v', index + 1)), 0, { key: 'playlist', query: 'PLtest', collection: null }, 'next');
    expect(needsQueuePage(first)).toBe(false);
    const nearEnd = { ...first, selectedEntryId: first.entries.at(-2)!.entryId };
    expect(needsQueuePage(nearEnd)).toBe(true);
    expect(needsQueuePage({ ...nearEnd, loading: true })).toBe(false);
    expect(needsQueuePage({ ...nearEnd, error: 'Offline' })).toBe(false);
    const appended = appendQueuePage(nearEnd, Array.from({ length: 24 }, (_, index) => item('v', index + 25)), 'another');
    expect(needsQueuePage(appended)).toBe(false);
    expect(needsQueuePage({ ...appended, selectedEntryId: null })).toBe(false);
  });
  it('keeps Mix history bounded without losing selected occurrence', () => {
    let queue = playlistQueue('mix', Array.from({ length: 96 }, (_, index) => item('v', index + 1)), 70, { key: 'mix', query: 'RDtest', collection: { id: 'mix', title: 'Mix', owner: '', thumbnail: null, itemCount: null, description: null, isMix: true, url: '' } }, 'next');
    const selected = queue.selectedEntryId; queue = boundMix(queue);
    expect(selectedIndex(queue)).toBe(24); expect(queue.selectedEntryId).toBe(selected); expect(queue.entries).toHaveLength(50);
    expect(needsQueuePage(queue)).toBe(false);
    queue.selectedEntryId = queue.entries.at(-2)!.entryId;
    expect(needsQueuePage(queue)).toBe(true);
    expect(needsQueuePage({ ...queue, isMix: false, loading: false })).toBe(true);
  });
});
