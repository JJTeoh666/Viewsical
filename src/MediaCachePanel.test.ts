import { describe, expect, it } from 'vitest';
import { cacheUsage } from './mediaCache';

describe('cache usage meter', () => {
  it('shows separate audio/video usage without painting beyond a reduced limit', () => {
    expect(cacheUsage({ maxBytes: 100, audioBytes: 20, videoBytes: 30 })).toEqual({ audio: 20, video: 30, pending: 0 });
    expect(cacheUsage({ maxBytes: 100, audioBytes: 80, videoBytes: 80 })).toEqual({ audio: 80, video: 20, pending: 0 });
    expect(cacheUsage({ maxBytes: 100, audioBytes: 130, videoBytes: 80 })).toEqual({ audio: 100, video: 0, pending: 0 });
    expect(cacheUsage({ maxBytes: 100, audioBytes: 20, videoBytes: 30, pendingBytes: 15 })).toEqual({ audio: 20, video: 30, pending: 15 });
  });
});
