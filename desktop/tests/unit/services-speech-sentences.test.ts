// EXP-003 behavior tests for sentence chunking (VOICE.md §1.1 stable short
// sentence splitting; §3.4 semantic-preserving bounded truncation) and for the
// streaming variant used by VoiceSession to flush complete sentences.
//
// Overflow rule (both functions share it): while a piece exceeds maxChars
// (counted in code points), split at the LAST soft boundary (，、；：,;: and
// space) inside the first maxChars chars — soft punctuation stays attached to
// the preceding piece; if the window has no soft boundary, hard-cut at
// maxChars. This bounds TTS sentence length without dropping characters.
import { describe, expect, it } from 'vitest';

import { chunkSentences, takeCompleteSentences } from '../../src/services/speech/sentences';

describe('chunkSentences', () => {
  it('splits on Chinese and English sentence boundaries, keeping punctuation attached', () => {
    expect(chunkSentences('你好！今天天气不错。真的吗？是的!ok?yes.')).toEqual([
      '你好！',
      '今天天气不错。',
      '真的吗？',
      '是的!',
      'ok?',
      'yes.',
    ]);
  });

  it('treats newlines as boundaries without emitting empty pieces', () => {
    expect(chunkSentences('第一行\n第二行\n\n第三行')).toEqual(['第一行', '第二行', '第三行']);
  });

  it('returns the trailing fragment without a boundary', () => {
    expect(chunkSentences('你好。后面没有标点')).toEqual(['你好。', '后面没有标点']);
  });

  it('returns an empty array for empty or whitespace-only text', () => {
    expect(chunkSentences('')).toEqual([]);
    expect(chunkSentences('   \n  ')).toEqual([]);
  });

  it('does not split a decimal number on its dot (semantics preservation)', () => {
    expect(chunkSentences('价格是3.14元')).toEqual(['价格是3.14元']);
  });

  it('splits overlong segments at soft boundaries and never exceeds maxChars', () => {
    const text = '这是一个非常长的句子，第一分句到这里结束，然后第二分句继续说到最后为止还没有句号';
    const pieces = chunkSentences(text, { maxChars: 12 });
    for (const piece of pieces) expect(Array.from(piece).length).toBeLessThanOrEqual(12);
    expect(pieces.join('')).toBe(text);
    expect(pieces.length).toBeGreaterThan(1);
  });

  it('hard-cuts an overlong segment when no soft boundary exists', () => {
    expect(chunkSentences('一二三四五六七', { maxChars: 3 })).toEqual(['一二三', '四五六', '七']);
  });

  it('is deterministic for repeated calls', () => {
    const text = '甲。乙！丙？丁';
    expect(chunkSentences(text)).toEqual(chunkSentences(text));
  });
});

describe('takeCompleteSentences (streaming flush)', () => {
  it('flushes only complete sentences and keeps the remainder', () => {
    expect(takeCompleteSentences('你好。今天')).toEqual({ sentences: ['你好。'], rest: '今天' });
  });

  it('flushes multiple complete sentences in order', () => {
    expect(takeCompleteSentences('一。二！三？四')).toEqual({
      sentences: ['一。', '二！', '三？'],
      rest: '四',
    });
  });

  it('returns nothing when no boundary has arrived yet', () => {
    expect(takeCompleteSentences('还没有句号')).toEqual({ sentences: [], rest: '还没有句号' });
    expect(takeCompleteSentences('')).toEqual({ sentences: [], rest: '' });
  });

  it('force-flushes an overlong remainder at its soft boundary', () => {
    expect(takeCompleteSentences('一二，三四五六七八', { maxChars: 4 })).toEqual({
      sentences: ['一二，', '三四五六'],
      rest: '七八',
    });
  });

  it('hard-flushes an overflow with no soft boundary at maxChars', () => {
    expect(takeCompleteSentences('一二三四五六', { maxChars: 4 })).toEqual({
      sentences: ['一二三四'],
      rest: '五六',
    });
  });
});
