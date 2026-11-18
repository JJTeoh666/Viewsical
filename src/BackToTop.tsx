import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

export function BackToTop({ enabled, pageKey }: { enabled: boolean; pageKey: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!enabled) { setVisible(false); return; }
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setVisible(window.scrollY > 320)); };
    update(); window.addEventListener('scroll', update, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', update); };
  }, [enabled, pageKey]);
  if (!enabled || !visible) return null;
  return <button className="back-to-top" aria-label="Back to top" title="Back to top" onClick={() => {
    document.querySelector<HTMLElement>('#main-content .page-heading h1')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }}><ArrowUp size={22} aria-hidden="true" /></button>;
}
