import { describe, expect, it } from 'vitest';
import { playerShortcut } from './playerShortcuts';
import type { ShortcutContext } from './playerShortcuts';
const normal: ShortcutContext = { loaded: true, blocked: false, editable: false, menu: false, button: false, playerRange: false, range: false, fullscreen: false };
describe('player keyboard shortcut scope', () => {
  it('uses exact five-point deltas, including on player ranges and buttons', () => {
    expect(playerShortcut({ key: 'ArrowUp' }, normal)).toEqual({ action: 'adjust-volume', value: 5 });
    expect(playerShortcut({ key: 'ArrowDown' }, { ...normal, range: true, playerRange: true })).toEqual({ action: 'adjust-volume', value: -5 });
    expect(playerShortcut({ key: 'ArrowUp' }, { ...normal, button: true })).toEqual({ action: 'adjust-volume', value: 5 });
  });
  it('does not consume editing, menu, dialog or unloaded arrow keys', () => {
    for (const context of [{ loaded: false }, { editable: true }, { menu: true }, { blocked: true }, { range: true, playerRange: false }]) expect(playerShortcut({ key: 'ArrowUp' }, { ...normal, ...context })).toBeNull();
  });
  it('preserves modified arrows and already-handled events', () => {
    for (const key of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true }]) expect(playerShortcut({ key: 'ArrowDown', ...key }, normal)).toBeNull();
  });
  it('does not also activate shortcuts for buttons or horizontal range arrows', () => {
    expect(playerShortcut({ key: ' ', code: 'Space' }, { ...normal, button: true })).toBeNull();
    expect(playerShortcut({ key: 'ArrowRight' }, { ...normal, range: true, playerRange: true })).toBeNull();
    expect(playerShortcut({ key: 'ArrowRight' }, normal)).toEqual({ action: 'seek-relative', value: 10 });
  });
  it('routes fullscreen Escape and control focus only in the intended contexts', () => {
    expect(playerShortcut({ key: 'Escape' }, normal)).toBeNull();
    expect(playerShortcut({ key: 'Escape' }, { ...normal, fullscreen: true })).toEqual({ action: 'fullscreen' });
    expect(playerShortcut({ key: 'k', ctrlKey: true }, normal)).toEqual({ action: 'focus-controls' });
  });
});
