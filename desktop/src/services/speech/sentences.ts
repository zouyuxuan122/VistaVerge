// EXP-003 sentence splitting for the streaming TTS chain.
//
// Authority: docs/product/VOICE.md §1.1 (stable short sentence splitting) and
// §3.4 (bounded buffers must never lose characters — length truncation has to
// preserve semantics). Boundaries: 。！？!?. and newlines. A "." between two
// digits is a decimal point, not a boundary. Overflow pieces split at the last
// soft boundary (，、；：,;: space) inside the maxChars window, else hard-cut;
// characters are never dropped, pieces always re-join to the input.
export interface SentenceOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 64;

const SENTENCE_ENDINGS = new Set(['。', '！', '？', '!', '?', '.']);
const SOFT_BREAKS = new Set(['，', '、', '；', '：', ',', ';', ':', ' ']);

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/** True when chars[index] ends a sentence (with the decimal-number guard). */
function isBoundary(chars: string[], index: number, mayContinue: boolean): boolean {
  const ch = chars[index];
  if (!SENTENCE_ENDINGS.has(ch)) return false;
  if (ch === '.') {
    const prev = index > 0 ? chars[index - 1] : undefined;
    const next = index + 1 < chars.length ? chars[index + 1] : undefined;
    // "3.14": a dot flanked by digits never ends a sentence. In streaming mode
    // an unknown right neighbor counts as a possible digit and is deferred.
    if (isDigit(prev) && (isDigit(next) || (next === undefined && mayContinue))) return false;
  }
  return true;
}

/**
 * Split an overlong piece: while it exceeds maxChars, cut at the last soft
 * boundary within the window (soft punctuation stays attached to the leading
 * piece), else hard-cut at maxChars. Returns emitted pieces plus the remainder
 * (never longer than maxChars). Loses no characters.
 */
function flushOverflow(
  chars: string[],
  maxChars: number,
): { pieces: string[]; restChars: string[] } {
  const pieces: string[] = [];
  let start = 0;
  while (chars.length - start > maxChars) {
    const windowEnd = start + maxChars;
    let cut = -1;
    for (let i = windowEnd - 1; i >= start; i -= 1) {
      if (SOFT_BREAKS.has(chars[i])) {
        cut = i;
        break;
      }
    }
    const end = cut >= 0 ? cut + 1 : windowEnd;
    pieces.push(chars.slice(start, end).join(''));
    start = end;
  }
  return { pieces, restChars: chars.slice(start) };
}

function emitSegment(sentences: string[], segment: string, maxChars: number): void {
  const chars = Array.from(segment);
  if (chars.length > maxChars) {
    const { pieces, restChars } = flushOverflow(chars, maxChars);
    sentences.push(...pieces, restChars.join(''));
  } else if (chars.length > 0) {
    sentences.push(segment);
  }
}

/** Split finished text into sentence pieces at 。！？!?.?\n boundaries. */
export function chunkSentences(text: string, options: SentenceOptions = {}): string[] {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const chars = Array.from(text);
  const sentences: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '\n') {
      emitSegment(sentences, current.join(''), maxChars);
      current = [];
      continue;
    }
    current.push(ch);
    if (isBoundary(chars, i, false)) {
      emitSegment(sentences, current.join(''), maxChars);
      current = [];
    }
  }
  emitSegment(sentences, current.join(''), maxChars);
  return sentences.filter((piece) => piece.trim().length > 0);
}

/**
 * Streaming variant: flush every complete sentence from the buffer and keep
 * the remainder (no trailing boundary yet). A remainder that already exceeds
 * maxChars is force-flushed at its best soft boundary so TTS latency stays
 * bounded even when the model streams without punctuation.
 */
export function takeCompleteSentences(
  text: string,
  options: SentenceOptions = {},
): { sentences: string[]; rest: string } {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const chars = Array.from(text);
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '\n') {
      emitSegment(sentences, chars.slice(start, i).join(''), maxChars);
      start = i + 1;
      continue;
    }
    if (isBoundary(chars, i, true)) {
      emitSegment(sentences, chars.slice(start, i + 1).join(''), maxChars);
      start = i + 1;
    }
  }
  const restChars = chars.slice(start);
  if (restChars.length > maxChars) {
    const { pieces, restChars: tail } = flushOverflow(restChars, maxChars);
    for (const piece of pieces) {
      if (piece.trim().length > 0) sentences.push(piece);
    }
    return { sentences, rest: tail.join('') };
  }
  return { sentences, rest: restChars.join('') };
}
