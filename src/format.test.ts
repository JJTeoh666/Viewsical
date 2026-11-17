import { describe, expect, it } from 'vitest';
import { bytes, errorMessage, progressPercent, time, uniqueItems, views } from './format';

describe('media display values', () => {
  it('formats long media positions without rolling over hours', () => {
    expect(time(3661.9)).toBe('1:01:01');
    expect(time(59.99)).toBe('0:59');
    expect(time(Number.NaN)).toBe('0:00');
    expect(time(-20)).toBe('0:00');
  });
  it('distinguishes unknown metadata from real zeroes', () => {
    expect(views(null)).toBe('');
    expect(views(0)).toBe('0 views');
    expect(bytes(null)).toBe('—');
    expect(bytes(0)).toBe('0 B');
    expect(bytes(1024 * 1024)).toBe('1.0 MB');
  });
  it('keeps the first result when continuation pages overlap', () => {
    expect(uniqueItems([{ id: 'a', title: 'first' }, { id: 'b', title: 'second' }, { id: 'a', title: 'repeat' }])).toEqual([{ id: 'a', title: 'first' }, { id: 'b', title: 'second' }]);
  });
  it('bounds progress and presents structured Rust errors', () => {
    expect(progressPercent(200)).toBe(100);
    expect(progressPercent(-2)).toBe(0);
    expect(progressPercent(Number.NaN)).toBe(0);
    expect(errorMessage({ code: 'expired', message: 'Sign in again.' })).toBe('Sign in again.');
  });
});
