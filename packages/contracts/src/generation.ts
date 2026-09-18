// FND-003 minimal generation gate for turn cancellation.
//
// `generation` is the cancellation generation of a session turn, not a global
// permission. Consumers capture the generation they belong to and reject late
// output whose generation no longer matches. This module is a pure primitive and
// is NOT wired into any runtime yet (see ../README.md).

/** Largest generation representable as a non-negative safe integer. */
export const GENERATION_MAX = Number.MAX_SAFE_INTEGER;

export type GenerationGateErrorCode = 'INVALID_INITIAL' | 'GENERATION_EXHAUSTED';

/** Coded error raised for invalid construction or exhausted advancement. */
export class GenerationGateError extends Error {
  readonly code: GenerationGateErrorCode;

  constructor(code: GenerationGateErrorCode, message: string) {
    super(message);
    this.name = 'GenerationGateError';
    this.code = code;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A per-session, monotonically increasing generation counter.
 *
 * - `current` is read-only.
 * - `advance()` increments by one and returns the new generation. Cancellation
 *   advances; resuming never rolls the generation back.
 * - `accepts(captured)` is true only for a non-negative safe integer equal to
 *   the current generation.
 * - At GENERATION_MAX, `advance()` throws instead of wrapping into a generation
 *   that was already used.
 *
 * Each session holds its own instance; instances never share state.
 */
export class GenerationGate {
  #current: number;

  constructor(initial: number = 0) {
    if (!isNonNegativeSafeInteger(initial)) {
      throw new GenerationGateError(
        'INVALID_INITIAL',
        'GenerationGate initial value must be a non-negative safe integer',
      );
    }
    this.#current = initial;
  }

  get current(): number {
    return this.#current;
  }

  advance(): number {
    if (this.#current >= GENERATION_MAX) {
      throw new GenerationGateError(
        'GENERATION_EXHAUSTED',
        'GenerationGate cannot advance beyond Number.MAX_SAFE_INTEGER',
      );
    }
    this.#current += 1;
    return this.#current;
  }

  accepts(captured: number): boolean {
    return isNonNegativeSafeInteger(captured) && captured === this.#current;
  }
}
