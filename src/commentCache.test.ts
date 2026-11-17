import { describe, expect, it, vi } from 'vitest';
import { CommentCache, commentKey } from './commentCache';
import type { CommentPage, CommentSort, VideoComment } from './types';

const comment = (id: string): VideoComment => ({ id, author: 'Viewer', authorThumbnail: null, text: `Comment ${id}`, likeCount: null, replyCount: null, published: null, authorIsUploader: false, isPinned: false });
const page = (videoId: string, items: VideoComment[] = [], nextCursor: string | null = null, sort: CommentSort = 'top'): CommentPage => ({ videoId, items, nextCursor, sort, totalCount: null, disabled: false });

describe('session comment cache', () => {
  it('keeps completed pages and sort orders while navigating without a refetch', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page('video', [comment('a')], 'next')).mockResolvedValueOnce(page('video', [comment('a'), comment('b')])).mockResolvedValueOnce(page('video', [comment('new')], null, 'newest'));
    const cache = new CommentCache(fetcher, vi.fn()); const top = commentKey(1, 'video', 'top'); const newest = commentKey(1, 'video', 'newest');
    cache.activate(top); await cache.ensure(top, 'video', 'top'); await cache.loadMore(top); cache.activate(null); cache.activate(top); await cache.ensure(top, 'video', 'top');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(cache.get(top)?.items.map(value => value.id)).toEqual(['a', 'b']);
    cache.activate(newest); await cache.ensure(newest, 'video', 'newest'); cache.activate(top); await cache.ensure(top, 'video', 'top');
    expect(fetcher).toHaveBeenCalledTimes(3); expect(cache.get(newest)?.items[0].id).toBe('new'); expect(cache.get(top)?.items[0].id).toBe('a');
  });
  it('cancels a stale video load and prevents late private comments after account reset', async () => {
    let resolve!: (page: CommentPage) => void; const fetcher = vi.fn(() => new Promise<CommentPage>(done => { resolve = done; })); const cancel = vi.fn();
    const cache = new CommentCache(fetcher, cancel); const key = commentKey(1, 'old', 'top'); cache.activate(key); const pending = cache.ensure(key, 'old', 'top');
    cache.activate(commentKey(1, 'new', 'top')); expect(cancel).toHaveBeenCalledOnce(); cache.clear(); resolve(page('old', [comment('private')])); await pending;
    expect(cache.get(key)).toBeUndefined();
  });
  it('retries failed continuations without replacing comments already shown', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page('video', [comment('a')], 'next')).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(page('video', [comment('b')]));
    const cache = new CommentCache(fetcher, vi.fn()); const key = commentKey(1, 'video', 'top'); cache.activate(key); await cache.ensure(key, 'video', 'top'); await cache.loadMore(key);
    expect(cache.get(key)?.items).toHaveLength(1); expect(cache.get(key)?.error).toBe('Connection lost'); await cache.retry(key);
    expect(fetcher.mock.calls.at(-1)?.[1]).toBe('next'); expect(cache.get(key)?.items.map(value => value.id)).toEqual(['a', 'b']); expect(cache.get(key)?.error).toBeNull();
  });
  it('bounds memory across videos and caps comment counts', async () => {
    const fetcher = vi.fn(async (id: string) => page(id, Array.from({ length: 305 }, (_, index) => comment(`${id}-${index}`)), 'more'));
    const cache = new CommentCache(fetcher, vi.fn(), 2);
    for (const id of ['one', 'two', 'three']) { const key = commentKey(1, id, 'top'); cache.activate(key); await cache.ensure(key, id, 'top'); }
    expect(cache.get(commentKey(1, 'one', 'top'))).toBeUndefined();
    const latest = cache.get(commentKey(1, 'three', 'top')); expect(latest?.items).toHaveLength(300); expect(latest?.limited).toBe(true); expect(latest?.nextCursor).toBeNull();
  });
});
