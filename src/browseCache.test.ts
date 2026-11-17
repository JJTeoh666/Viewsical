import { describe, expect, it, vi } from 'vitest';
import { BrowseCache, browseKey } from './browseCache';
import type { BrowsePage, MediaItem } from './types';
const item = (id: string): MediaItem => ({ id, kind: 'video', title: id, channel: '', thumbnail: null, url: '', duration: null, viewCount: null, description: null });
const page = (items: MediaItem[] = [], nextCursor: string | null = null): BrowsePage => ({ items, nextCursor });

describe('session browse cache', () => {
  it('retains an empty successful page, continuation and scroll until explicit refresh', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page([item('new')], 'page2')).mockResolvedValueOnce(page([item('next')]));
    const cache = new BrowseCache(fetcher, vi.fn()); const key = browseKey(1, 'home');
    await cache.ensure(key, 'home', ''); await cache.ensure(key, 'home', '');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await cache.refresh(key, 'home', ''); await cache.loadMore(key); cache.saveScroll(key, 430);
    await cache.ensure(key, 'home', '');
    expect(fetcher).toHaveBeenCalledTimes(3); expect(cache.get(key)?.items.map(value => value.id)).toEqual(['new', 'next']); expect(cache.get(key)?.scrollY).toBe(430);
  });
  it('shares pending requests and rejects late results after account changes', async () => {
    let resolve!: (value: BrowsePage) => void;
    const fetcher = vi.fn(() => new Promise<BrowsePage>(done => { resolve = done; })); const cancel = vi.fn();
    const cache = new BrowseCache(fetcher, cancel); const key = browseKey(1, 'playlists');
    const pending = cache.ensure(key, 'playlists', ''); await cache.ensure(key, 'playlists', '');
    cache.clear(); resolve(page([item('private')])); await expect(pending).rejects.toThrow('replaced');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledOnce(); expect(cache.get(key)).toBeUndefined();
  });
  it('preserves duplicate playlist occurrences while removing overlapping feed results', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page([item('same'), item('same')], 'next')).mockResolvedValueOnce(page([item('same')]));
    const cache = new BrowseCache(fetcher, vi.fn()); const key = browseKey(1, 'playlist', 'PLtest');
    await cache.ensure(key, 'playlist', 'PLtest'); await cache.loadMore(key);
    expect(cache.get(key)?.items).toHaveLength(3);
  });
});
