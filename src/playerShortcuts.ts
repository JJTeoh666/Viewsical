export interface ShortcutContext { loaded: boolean; blocked: boolean; editable: boolean; menu: boolean; button: boolean; playerRange: boolean; range: boolean; fullscreen: boolean }
export interface ShortcutKey { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; defaultPrevented?: boolean }
export type ShortcutIntent = { action: 'adjust-volume' | 'toggle' | 'seek-relative' | 'mute' | 'fullscreen' | 'focus-controls'; value?: number };
/** Scope before preventing defaults, so editable and menu arrows keep their native roles. */
export function playerShortcut(key: ShortcutKey, context: ShortcutContext): ShortcutIntent | null {
  if (key.defaultPrevented || !context.loaded || context.blocked || context.menu || context.editable) return null;
  if ((key.ctrlKey || key.metaKey) && !key.altKey && !key.shiftKey && key.key.toLowerCase() === 'k') return { action: 'focus-controls' };
  if (key.ctrlKey || key.metaKey || key.altKey || key.shiftKey) return null;
  if ((key.key === 'ArrowUp' || key.key === 'ArrowDown') && (!context.range || context.playerRange)) return { action: 'adjust-volume', value: key.key === 'ArrowUp' ? 5 : -5 };
  if (context.button || context.range) return null;
  if (key.code === 'Space' || key.key === ' ' || key.key.toLowerCase() === 'k') return { action: 'toggle' };
  if (key.key === 'ArrowRight' || key.key.toLowerCase() === 'l') return { action: 'seek-relative', value: 10 };
  if (key.key === 'ArrowLeft' || key.key.toLowerCase() === 'j') return { action: 'seek-relative', value: -10 };
  if (key.key.toLowerCase() === 'm') return { action: 'mute' };
  if (key.key.toLowerCase() === 'f' || (key.key === 'Escape' && context.fullscreen)) return { action: 'fullscreen' };
  return null;
}
