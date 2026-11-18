import type { PlayerBounds } from './types';

/** Keep the original video rectangle while clipping it at the native viewport. */
export function playerViewport(rect: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>, width: number, height: number, headerBottom: number, scale: number, allowed: boolean, fullscreen: boolean): PlayerBounds {
  const top = fullscreen ? 0 : Math.max(0, headerBottom);
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
    viewportTop: Math.ceil(top * scale),
    radius: fullscreen ? 0 : Math.round(12 * scale),
    visible: allowed && rect.width > 1 && rect.height > 1 && rect.y + rect.height > top + 1 && rect.y < height - 1 && rect.x + rect.width > 1 && rect.x < width - 1,
  };
}
