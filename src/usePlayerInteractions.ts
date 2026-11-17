import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PlayerAction, PlayerState } from './types';
import { playerShortcut } from './playerShortcuts';

const blockingModalSelector = 'dialog[open],[role="dialog"][aria-modal="true"]';
/** Independent dialogs can live outside Application state (for example cache dialogs). */
export function useBlockingModal() {
  const [blocked, setBlocked] = useState(() => !!document.querySelector(blockingModalSelector));
  useEffect(() => {
    const update = () => setBlocked(previous => { const next = !!document.querySelector(blockingModalSelector); return previous === next ? previous : next; });
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'role', 'aria-modal'] });
    update();
    return () => observer.disconnect();
  }, []);
  return blocked;
}


export function usePlayerShortcuts({ player, blocked = false, fullscreen, onAction, onFullscreen, onFocusControls }: { player: PlayerState; blocked?: boolean; fullscreen: boolean; onAction: (action: PlayerAction, value?: number) => void; onFullscreen: () => void; onFocusControls?: () => void }) {
  const current = useRef({ player, blocked, fullscreen, onAction, onFullscreen, onFocusControls });
  current.current = { player, blocked, fullscreen, onAction, onFullscreen, onFocusControls };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const value = current.current, target = event.target instanceof Element ? event.target : null;
      const range = target instanceof HTMLInputElement && target.type === 'range';
      const intent = playerShortcut(event, { loaded: !!value.player.video, blocked: value.blocked || !!document.querySelector(blockingModalSelector), menu: !!target?.closest('[role="menu"],[role="menubar"],[role="listbox"],[role="dialog"]'), editable: !!target?.closest('textarea,select,[contenteditable]:not([contenteditable="false"])') || (target instanceof HTMLInputElement && !range), button: !!target?.closest('button,a'), range, playerRange: range && !!target?.hasAttribute('data-player-range'), fullscreen: value.fullscreen });
      if (!intent || (intent.action === 'focus-controls' && !value.onFocusControls)) return;
      event.preventDefault(); event.stopPropagation();
      if (intent.action === 'fullscreen') value.onFullscreen();
      else if (intent.action === 'focus-controls') value.onFocusControls?.();
      else if (intent.action === 'seek-relative') value.onAction('seek', Math.max(0, Math.min(value.player.duration, value.player.position + (intent.value ?? 0))));
      else if (intent.action === 'mute') value.onAction('mute', value.player.muted ? 0 : 1);
      else value.onAction(intent.action, intent.value);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
}

export function usePlayerVisibility(player: PlayerState) {
  const [visible, setVisible] = useState(false);
  const inside = useRef(false), menu = useRef(false), dragging = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const paused = useRef(player.status === 'paused'); paused.current = player.status === 'paused';
  const clear = useCallback(() => { clearTimeout(timer.current); }, []);
  const arm = useCallback(() => {
    clear();
    if (inside.current && !menu.current && !dragging.current && !paused.current) timer.current = setTimeout(() => setVisible(false), 2500);
  }, [clear]);
  const reveal = useCallback(() => { inside.current = true; setVisible(true); arm(); }, [arm]);
  const hide = useCallback(() => { inside.current = false; menu.current = false; clear(); setVisible(false); }, [clear]);
  const onMenuChange = useCallback((open: boolean) => { menu.current = open; if (open) clear(); else arm(); }, [arm, clear]);
  const onDragging = useCallback((active: boolean) => { dragging.current = active; if (active) clear(); else arm(); }, [arm, clear]);
  useEffect(() => { if (inside.current && paused.current) setVisible(true); arm(); }, [player.status, arm]);
  useEffect(() => { menu.current = false; dragging.current = false; setVisible(inside.current); arm(); }, [player.loadId, arm]);
  useEffect(() => { window.addEventListener('blur', hide); return () => { clear(); window.removeEventListener('blur', hide); }; }, [hide, clear]);
  return { visible, reveal, hide, onMenuChange, onDragging };
}

/** Only a matching empty-surface press/release may toggle playback. */
export function usePlayerSurfaceClicks(loadId: number, onToggle: () => void, onFullscreen: () => void) {
  const current = useRef({ loadId, onToggle, onFullscreen }); current.current = { loadId, onToggle, onFullscreen };
  const press = useRef<{ x: number; y: number; pointer: number; load: number } | null>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => { press.current = null; clearTimeout(timer.current); timer.current = undefined; }, []);
  useEffect(() => { cancel(); return cancel; }, [loadId, cancel]);
  const interactive = (target: EventTarget | null) => target instanceof Element && !target.closest('[data-player-surface-toggle]') && !!target.closest('button,input,select,a,[role="menu"],[data-player-interactive]');
  return {
    cancel,
    onPointerDown(event: ReactPointerEvent) { if (event.button === 0 && !interactive(event.target)) press.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId, load: current.current.loadId }; else press.current = null; },
    onPointerUp(event: ReactPointerEvent) {
      const down = press.current; press.current = null;
      if (!down || down.load !== current.current.loadId || down.pointer !== event.pointerId || interactive(event.target) || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
      if (timer.current) { cancel(); current.current.onFullscreen(); return; }
      const load = current.current.loadId;
      timer.current = setTimeout(() => { timer.current = undefined; if (current.current.loadId === load) current.current.onToggle(); }, 250);
    },
    onPointerCancel: cancel,
  };
}
