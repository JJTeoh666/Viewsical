import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { time } from './format';
import { Modal } from './ui';

export function ShareVideoDialog({ videoId, position, onClose }: {
  videoId: string;
  position: number;
  onClose: () => void;
}) {
  const [startAt, setStartAt] = useState(false);
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'manual'>('idle');
  const field = useRef<HTMLInputElement>(null);
  const seconds = Number.isFinite(position) ? Math.max(0, Math.floor(position)) : 0;
  const link = `https://youtu.be/${encodeURIComponent(videoId)}${startAt ? `?t=${seconds}` : ''}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setFeedback('copied');
    } catch {
      // Some WebView2 configurations disable the asynchronous Clipboard API.
      field.current?.focus();
      field.current?.select();
      setFeedback(document.execCommand('copy') ? 'copied' : 'manual');
    }
  }

  return <Modal title="Share video" onClose={onClose}>
    <div className="share-link">
      <input ref={field} aria-label="Video link" value={link} readOnly onFocus={event => event.target.select()} />
      <button type="button" className="button secondary" onClick={() => void copyLink()}>
        {feedback === 'copied' ? <Check size={16} /> : <Copy size={16} />}
        {feedback === 'copied' ? 'Copied' : 'Copy link'}
      </button>
    </div>
    <label className="share-start"><input type="checkbox" checked={startAt} onChange={event => {
      setStartAt(event.target.checked);
      setFeedback('idle');
    }} /> Start at <strong>{time(seconds)}</strong></label>
    <div className="sr-only" role="status">{feedback === 'copied' ? 'Link copied' : ''}</div>
    {feedback === 'manual' && <p className="field-help" role="status">Press Ctrl+C to copy the selected link.</p>}
  </Modal>;
}
