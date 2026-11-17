import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import './scroll-loader.css';

interface Props {
  scope: string; cursor: string | null; loading: boolean; error?: string | null;
  onLoad: () => void; scrollRoot?: RefObject<HTMLElement | null>; compact?: boolean;
}

/** One continuation per approach to the end. Appending never drains the list. */
export function ScrollLoader({ scope, cursor, loading, error, onLoad, scrollRoot, compact = false }: Props) {
  const sentinel = useRef<HTMLDivElement>(null);
  const current = useRef({ cursor, loading, error, onLoad });
  current.current = { cursor, loading, error, onLoad };
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !('IntersectionObserver' in window)) return;
    const root = scrollRoot?.current ?? null;
    let near = false; let armed = true; let lastCursor: string | null = null;
    let lastRequestScroll = root?.scrollTop ?? window.scrollY;
    function request() {
      const value = current.current;
      if (!near || !armed || !value.cursor || value.loading || value.error || value.cursor === lastCursor) return;
      armed = false; lastCursor = value.cursor; lastRequestScroll = root?.scrollTop ?? window.scrollY;
      value.onLoad();
    }
    const observer = new IntersectionObserver(entries => {
      near = entries.some(entry => entry.isIntersecting);
      if (!near) armed = true;
      request();
    }, { root, rootMargin: compact ? '0px 0px 100px 0px' : '0px 0px 280px 0px' });
    observer.observe(target);
    function scroll() {
      // A short page may leave the sentinel in view. Another real downward
      // scroll may request one more page, without a render/request waterfall.
      const position = root?.scrollTop ?? window.scrollY;
      if (position > lastRequestScroll + 60) armed = true;
      request();
    }
    const scrollTarget = root ?? window;
    scrollTarget.addEventListener('scroll', scroll, { passive: true });
    return () => { observer.disconnect(); scrollTarget.removeEventListener('scroll', scroll); };
  }, [scope, scrollRoot, compact]);
  if (!cursor) return null;
  return <div ref={sentinel} className={`scroll-loader ${compact ? 'scroll-loader-compact' : ''}`}>
    <button className="button secondary" disabled={loading} onClick={onLoad}>
      {loading ? <LoaderCircle size={compact ? 14 : 18} className="spin" /> : error ? <RefreshCw size={compact ? 14 : 18} /> : <ChevronDown size={compact ? 14 : 18} />}
      {loading ? 'Loading more…' : error ? 'Try loading more again' : 'Load more'}
    </button>
    <span className="sr-only" role="status">{loading ? 'Loading more videos' : ''}</span>
  </div>;
}
