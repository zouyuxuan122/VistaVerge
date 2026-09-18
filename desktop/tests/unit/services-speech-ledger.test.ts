// EXP-003 behavior tests for the sentence-level PlaybackLedger
// (VOICE.md §3.3 actual played text: sentence granularity is the only honest
// granularity without phoneme alignment; playedThrough must never regress,
// including after aborts, so retries resume from the last confirmed boundary).
import { describe, expect, it } from 'vitest';

import { PlaybackLedger } from '../../src/services/speech/ledger';

describe('PlaybackLedger', () => {
  it('counts the consecutive confirmed prefix as playedThrough', () => {
    const ledger = new PlaybackLedger();
    expect(ledger.playedThrough()).toBe(0);
    ledger.markQueued(0);
    ledger.markQueued(1);
    ledger.markPlayed(0);
    expect(ledger.playedThrough()).toBe(1); // sentence 0 confirmed → resume point 1
    ledger.markPlayed(1);
    expect(ledger.playedThrough()).toBe(2);
  });

  it('does not advance across a gap: unplayed holes stop the prefix', () => {
    const ledger = new PlaybackLedger();
    ledger.markPlayed(0);
    ledger.markPlayed(2);
    expect(ledger.playedThrough()).toBe(1);
  });

  it('never regresses after an abort (interrupt mid-sentence)', () => {
    const ledger = new PlaybackLedger();
    ledger.markPlayed(0);
    ledger.markPlayed(1);
    ledger.markAborted(2);
    expect(ledger.playedThrough()).toBe(2);
    // more aborts of later sentences must not lower the watermark either
    ledger.markAborted(3);
    ledger.markAborted(4);
    expect(ledger.playedThrough()).toBe(2);
  });

  it('an abort on an already-played sentence does not roll the prefix back', () => {
    const ledger = new PlaybackLedger();
    ledger.markPlayed(0);
    ledger.markPlayed(1);
    ledger.markAborted(0);
    ledger.markAborted(1);
    expect(ledger.playedThrough()).toBe(2);
  });

  it('a retry re-marking the aborted sentence extends playedThrough', () => {
    const ledger = new PlaybackLedger();
    ledger.markPlayed(0);
    ledger.markAborted(1);
    expect(ledger.playedThrough()).toBe(1);
    ledger.markPlayed(1);
    expect(ledger.playedThrough()).toBe(2);
  });

  it('reports sentence-level counts for observability', () => {
    const ledger = new PlaybackLedger();
    ledger.markQueued(0);
    ledger.markQueued(1);
    ledger.markQueued(2);
    ledger.markPlayed(0);
    ledger.markAborted(1);
    expect(ledger.counts()).toEqual({ queued: 3, played: 1, aborted: 1 });
  });
});
