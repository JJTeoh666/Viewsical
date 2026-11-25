import { Fragment } from 'react';
import { textTimestamps } from './textTimestamps';

export function TimestampText({ text, duration, onSeek, visibleLength = text.length }: {
  text: string;
  duration: number;
  onSeek: (seconds: number) => void;
  visibleLength?: number;
}) {
  // Parse the full text so a truncated timestamp or URL in an excerpt stays plain text.
  const timestamps = textTimestamps(text, duration).filter(({ label, index }) => index + label.length <= visibleLength);
  let start = 0;
  const content = timestamps.map(({ index, label, seconds }) => {
    const precedingText = text.slice(start, index);
    start = index + label.length;
    return <Fragment key={index}>{precedingText}<button type="button" className="text-timestamp" dir="ltr"
      aria-label={`Jump to ${label}`} onClick={() => onSeek(seconds)}>{label}</button></Fragment>;
  });
  return <>{content}{text.slice(start, visibleLength)}</>;
}
