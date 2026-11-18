import type { PlayerBounds } from './types';

/** Keep the original video rectangle while clipping it at the native viewport. */
export function playerViewport(rect: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>, width: number, height: number, headerBottom: number, scale: number, allowed: boolean, fullscreen: boolean): PlayerBounds {
  const top = fullscreen ? 0 : Math.max(0, headerBottom);
  return {
    x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale,
    viewportTop: top * scale, radius: fullscreen ? 0 : 12 * scale,
    visible: allowed && rect.width > 1 && rect.height > 1 && rect.y + rect.height > top + 1 && rect.y < height - 1 && rect.x + rect.width > 1 && rect.x < width - 1,
  };
}
