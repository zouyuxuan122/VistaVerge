// EXP-003 sentence-level playback ledger (VOICE.md §3.3 "播放账本").
//
// Without phoneme alignment the only honest granularity is whole sentences:
// playedThrough() is the count of consecutively confirmed sentences from the
// start of the reply. It is a high-water mark — aborts never roll it back —
// so retries resume from the last confirmed sentence boundary and never claim
// a mid-sentence position.
export interface LedgerCounts {
  queued: number;
  played: number;
  aborted: number;
}

export class PlaybackLedger {
  #queued = new Set<number>();
  #played = new Set<number>();
  #aborted = new Set<number>();
  #highWater = 0;

  markQueued(index: number): void {
    this.#queued.add(index);
  }

  /** The sentence's audio was confirmed played to its end. */
  markPlayed(index: number): void {
    this.#played.add(index);
    let contiguous = 0;
    while (this.#played.has(contiguous)) contiguous += 1;
    if (contiguous > this.#highWater) this.#highWater = contiguous;
  }

  /** The sentence was interrupted or dropped; it stays unconfirmed. */
  markAborted(index: number): void {
    this.#aborted.add(index);
  }

  /** Confirmed sentence prefix; monotonically non-decreasing. */
  playedThrough(): number {
    return this.#highWater;
  }

  counts(): LedgerCounts {
    return { queued: this.#queued.size, played: this.#played.size, aborted: this.#aborted.size };
  }
}
