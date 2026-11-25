const textToken = /\b(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}:/_.-])(?:\d{1,3}:[0-5]\d:[0-5]\d|\d{1,4}:[0-5]\d)(?![\p{L}\p{N}:/_-]|\.\d)/giu;

export function textTimestamps(text: string, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  return Array.from(text.matchAll(textToken)).flatMap(match => {
    const label = match[0];
    if (!/^\d/.test(label)) return [];
    const seconds = label.split(':').reduce((elapsed, piece) => elapsed * 60 + Number(piece), 0);
    return seconds <= duration ? [{ label, seconds, index: match.index }] : [];
  });
}
