import { describe, expect, it } from 'vitest';
import { playerViewport } from './playerViewport';

const rect = { x: 240, y: 120, width: 800, height: 450 };
describe('native video viewport during scrolling', () => {
  it('keeps partially scrolled video visible at its original size and scale', () => {
    const value = playerViewport({ ...rect, y: -100 }, 1440, 920, 64, 1.25, true, false);
    expect(value).toMatchObject({ x: 300, y: -125, width: 1000, height: 563, viewportTop: 80, visible: true });
  });
  it('keeps measurements within the same physical pixel identical', () => {
    const first = playerViewport({ ...rect, y: 120.1 }, 1440, 920, 64.1, 1.25, true, false);
    const second = playerViewport({ ...rect, y: 120.2 }, 1440, 920, 64.1, 1.25, true, false);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ y: 150, viewportTop: 81 });
  });
  it('renders the visible part when the bottom extends beyond the viewport', () => {
    expect(playerViewport({ ...rect, y: 800 }, 1440, 920, 64, 1, true, false).visible).toBe(true);
  });
  it('hides only fully offscreen or blocked surfaces', () => {
    expect(playerViewport({ ...rect, y: -450 }, 1440, 920, 64, 1, true, false).visible).toBe(false);
    expect(playerViewport({ ...rect, y: 920 }, 1440, 920, 64, 1, true, false).visible).toBe(false);
    expect(playerViewport(rect, 1440, 920, 64, 1, false, false).visible).toBe(false);
  });
  it('removes the header exclusion and corner radius in fullscreen', () => {
    expect(playerViewport({ ...rect, y: 0 }, 1440, 920, 64, 2, true, true)).toMatchObject({ viewportTop: 0, radius: 0, visible: true });
  });
});
