import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { MediaItem } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
const { api } = await import('./api');
const video: MediaItem = { id: 'test-video', kind: 'video', title: 'Test video', channel: '', thumbnail: null, url: '', duration: 60, viewCount: null, description: null };

beforeEach(() => vi.mocked(invoke).mockClear());
afterAll(() => vi.unstubAllGlobals());

describe('fresh playback', () => {
  it('opens the video without a saved position', async () => {
    await api.playVideo(video, 1080);
    expect(invoke).toHaveBeenCalledWith('play_video', { item: video, quality: 1080, playbackMode: null });
  });

  it('passes the selected playback mode', async () => {
    await api.playVideo(video, 720, 'audio');
    expect(invoke).toHaveBeenLastCalledWith('play_video', { item: video, quality: 720, playbackMode: 'audio' });
  });
});
