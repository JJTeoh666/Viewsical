import type { MediaCacheSummary } from './types';
export const GiB = 1024 ** 3;
export const cacheLimits = [512 * 1024 ** 2, GiB, 2 * GiB, 5 * GiB, 10 * GiB];
export function cacheUsage(summary: Pick<MediaCacheSummary, 'maxBytes' | 'audioBytes' | 'videoBytes'> & { pendingBytes?: number }) {
  const maximum = Math.max(1, summary.maxBytes);
  const audio = Math.min(100, Math.max(0, summary.audioBytes / maximum * 100));
  const video = Math.min(100 - audio, Math.max(0, summary.videoBytes / maximum * 100));
  return { audio, video, pending: Math.min(100 - audio - video, Math.max(0, (summary.pendingBytes ?? 0) / maximum * 100)) };
}
