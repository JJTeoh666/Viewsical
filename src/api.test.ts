import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { MediaItem } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
const { api } = await import('./api');
const video: MediaItem = { id: 'test-video', kind: 'video', title: 'Test video', channel: '', thumbnail: null, url: '', duration: 60, viewCount: null, description: null };

beforeEach(() => vi.mocked(invoke).mockClear());
afterAll(() => vi.unstubAllGlobals());

describe('playback position handoff', () => {
  it('lets the backend restore a saved position when no start is requested', async () => {
    await api.playVideo(video, 1080);
    expect(invoke).toHaveBeenCalledWith('play_video', { item: video, quality: 1080, startSeconds: null, playbackMode: null });
  });

  it('preserves explicit replay and history positions', async () => {
    await api.playVideo(video, 720, 0);
    expect(invoke).toHaveBeenLastCalledWith('play_video', { item: video, quality: 720, startSeconds: 0, playbackMode: null });
    await api.playVideo(video, 720, 32.5);
    expect(invoke).toHaveBeenLastCalledWith('play_video', { item: video, quality: 720, startSeconds: 32.5, playbackMode: null });
  });
});
