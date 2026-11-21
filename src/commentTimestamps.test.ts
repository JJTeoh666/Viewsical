import { expect, it } from 'vitest';
import { commentTimestamps } from './commentTimestamps';

it('recognizes minutes and hours and preserves their original character offsets', () => {
  const text = '♫ (5:11) is great. Then 1:05:02!';
  expect(commentTimestamps(text, 4000)).toEqual([
    { label: '5:11', seconds: 311, index: 3 },
    { label: '1:05:02', seconds: 3902, index: 24 },
  ]);
});

it('ignores URLs, malformed times, attached identifiers and out-of-range times', () => {
  const text = 'https://example.test/?t=0:12 www.test.com/0:12 vid2:34 1:61 2:03:65 1:05.2 5:11 0:08.';
  expect(commentTimestamps(text, 300).map(({ label }) => label)).toEqual(['0:08']);
  expect(commentTimestamps(text, 0)).toEqual([]);
});
