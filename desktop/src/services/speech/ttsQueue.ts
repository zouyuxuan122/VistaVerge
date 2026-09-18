// EXP-003 bounded TTS queue with backpressure (VOICE.md §3.4) and
// generation-scoped cancellation (VOICE.md §3.1).
//
// - Sentences are synthesized and played strictly one at a time, in enqueue
//   order. Capacity counts queued + in-flight sentences. Crossing it emits
//   `backpressure {paused:true}` so the upstream (LLM delta consumer) pauses
//   pulling; dropping below it emits `{paused:false}`. Nothing is ever dropped
//   by backpressure — only cancellation and stale generations drop audio.
// - `cancel(generation)` invalidates every item with generation <= the given
//   one: in-flight synthesis/playback is aborted and queued items are removed.
//   Enqueues with an already-canceled generation are dropped on arrival.
//
// Events (CustomEvent detail: sentence/generation/seq + extras):
//   audio         playback of a sentence is about to start
//   played        sentence confirmed played to the end
//   aborted       in-flight sentence canceled (cancel())
//   dropped       queued sentence removed (reason: canceled | stale-generation)
//   error         sentence failed (message); queue continues with the next one
//   backpressure  {paused} upstream pause/resume signal
//   drained       queue fully drained (after the last settle)
export interface TtsQueueDeps {
  synthesize: (text: string, signal: AbortSignal) => Promise<Int16Array>;
  play: (pcm: Int16Array, signal: AbortSignal) => Promise<void>;
  capacity?: number;
}

export interface TtsQueueStats {
  queued: number;
  capacity: number;
  playing: boolean;
  paused: boolean;
  played: number;
  dropped: number;
  errors: number;
}

export interface TtsQueueEventDetail {
  sentence: string;
  generation: number;
  seq: number;
  paused?: boolean;
  reason?: 'canceled' | 'stale-generation';
  message?: string;
}

export type TtsQueueAudioDetail = Pick<TtsQueueEventDetail, 'sentence' | 'generation' | 'seq'>;

interface QueueItem {
  sentence: string;
  generation: number;
  seq: number;
  settled: boolean;
}

const DEFAULT_CAPACITY = 4;

export class TtsQueue extends EventTarget {
  #synthesize: TtsQueueDeps['synthesize'];
  #play: TtsQueueDeps['play'];
  #capacity: number;
  #queue: QueueItem[] = [];
  #current: { item: QueueItem; controller: AbortController } | null = null;
  #pumping = false;
  #paused = false;
  #played = 0;
  #dropped = 0;
  #errors = 0;
  #seq = 0;
  #cancelFloor = -1;
  #drainWaiters: (() => void)[] = [];

  constructor(deps: TtsQueueDeps) {
    super();
    this.#synthesize = deps.synthesize;
    this.#play = deps.play;
    this.#capacity = Math.max(1, deps.capacity ?? DEFAULT_CAPACITY);
  }

  get capacity(): number {
    return this.#capacity;
  }

  enqueue(sentence: string, generation: number): void {
    if (!sentence || sentence.trim().length === 0) return;
    if (generation <= this.#cancelFloor) {
      this.#dropped += 1;
      this.#emit('dropped', { sentence, generation, seq: -1, reason: 'stale-generation' });
      return;
    }
    const item: QueueItem = { sentence, generation, seq: this.#seq, settled: false };
    this.#seq += 1;
    this.#queue.push(item);
    if (!this.#paused && this.#inSystem() >= this.#capacity) {
      this.#paused = true;
      this.#emit('backpressure', { ...detailOf(item), paused: true });
    }
    this.#pump();
  }

  /** Register an "about to play" listener; returns an unsubscribe function. */
  onAudio(cb: (detail: TtsQueueAudioDetail) => void): () => void {
    const handler = (event: Event) => cb((event as CustomEvent<TtsQueueAudioDetail>).detail);
    this.addEventListener('audio', handler);
    return () => this.removeEventListener('audio', handler);
  }

  /** Invalidate everything at or below `generation` (VOICE.md §3.1). */
  cancel(generation: number): void {
    if (generation > this.#cancelFloor) this.#cancelFloor = generation;
    const current = this.#current;
    if (current && current.item.generation <= generation && !current.item.settled) {
      current.item.settled = true;
      this.#dropped += 1;
      current.controller.abort();
      this.#emit('aborted', detailOf(current.item));
      this.#current = null;
    }
    const keep: QueueItem[] = [];
    for (const item of this.#queue) {
      if (item.generation <= generation) {
        item.settled = true;
        this.#dropped += 1;
        this.#emit('dropped', { ...detailOf(item), reason: 'canceled' });
      } else {
        keep.push(item);
      }
    }
    this.#queue = keep;
    this.#maybeResume();
    // 只有泵没在跑时才在这里结算：泵在跑时它自己的 finally 会结算，
    // 否则 cancel() 先发一次 drained，泵退出时再发一次（消费者会跑两遍）。
    if (this.#current === null && this.#queue.length === 0 && !this.#pumping) this.#resolveDrained();
  }

  stats(): TtsQueueStats {
    return {
      queued: this.#queue.length,
      capacity: this.#capacity,
      playing: this.#current !== null,
      paused: this.#paused,
      played: this.#played,
      dropped: this.#dropped,
      errors: this.#errors,
    };
  }

  /** Resolves once the queue has nothing in flight (played or dropped). */
  whenDrained(): Promise<void> {
    if (this.#current === null && this.#queue.length === 0 && !this.#pumping) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
  }

  #inSystem(): number {
    return this.#queue.length + (this.#current !== null ? 1 : 0);
  }

  #maybeResume(): void {
    if (this.#paused && this.#inSystem() < this.#capacity) {
      this.#paused = false;
      const item = this.#queue[0];
      this.#emit('backpressure', {
        sentence: item?.sentence ?? '',
        generation: item?.generation ?? 0,
        seq: item?.seq ?? -1,
        paused: false,
      });
    }
  }

  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    void this.#drainLoop();
  }

  async #drainLoop(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift()!;
        const controller = new AbortController();
        this.#current = { item, controller };
        // resume check must include the just-shifted in-flight item
        this.#maybeResume();
        try {
          const pcm = await this.#synthesize(item.sentence, controller.signal);
          if (controller.signal.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }
          if (!item.settled) {
            this.#emit('audio', detailOf(item));
          }
          await this.#play(pcm, controller.signal);
          if (!item.settled) {
            item.settled = true;
            this.#played += 1;
            this.#emit('played', detailOf(item));
          }
        } catch (err) {
          if (!item.settled) {
            item.settled = true;
            const aborted =
              controller.signal.aborted || (err as Error)?.name === 'AbortError';
            if (aborted) {
              this.#dropped += 1;
              this.#emit('aborted', detailOf(item));
            } else {
              this.#errors += 1;
              this.#emit('error', {
                ...detailOf(item),
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } finally {
          if (this.#current?.item === item) this.#current = null;
          this.#maybeResume();
        }
      }
    } finally {
      this.#pumping = false;
      if (this.#queue.length === 0) this.#resolveDrained();
    }
  }

  #resolveDrained(): void {
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const resolve of waiters) resolve();
    this.dispatchEvent(new CustomEvent<TtsQueueEventDetail>('drained', {
      detail: { sentence: '', generation: 0, seq: -1 },
    }));
  }

  #emit(type: string, detail: TtsQueueEventDetail): void {
    this.dispatchEvent(new CustomEvent<TtsQueueEventDetail>(type, { detail }));
  }
}

function detailOf(item: QueueItem): TtsQueueAudioDetail {
  return { sentence: item.sentence, generation: item.generation, seq: item.seq };
}
