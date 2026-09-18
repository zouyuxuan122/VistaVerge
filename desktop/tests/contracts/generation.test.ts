// FND-003 contract tests for GenerationGate: the minimal turn cancellation
// generation primitive. Written before the implementation exists.
import { describe, expect, it } from 'vitest';
import {
  GENERATION_MAX,
  GenerationGate,
  GenerationGateError,
} from '../../../packages/contracts/src/generation';

describe('GenerationGate: construction and current', () => {
  it('defaults to generation 0', () => {
    const gate = new GenerationGate();
    expect(gate.current).toBe(0);
    expect(gate.accepts(0)).toBe(true);
    expect(gate.accepts(1)).toBe(false);
  });

  it('accepts an explicit non-negative safe integer initial value', () => {
    const gate = new GenerationGate(5);
    expect(gate.current).toBe(5);
    expect(gate.accepts(5)).toBe(true);
    expect(gate.accepts(4)).toBe(false);
  });

  it('treats an explicit undefined initial as the default 0', () => {
    const gate = new GenerationGate(undefined);
    expect(gate.current).toBe(0);
  });

  it('rejects an invalid initial value with a coded error', () => {
    const bad = [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null];
    for (const value of bad) {
      let thrown: unknown;
      try {
        new GenerationGate(value as number);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GenerationGateError);
      expect((thrown as GenerationGateError).code).toBe('INVALID_INITIAL');
      expect((thrown as GenerationGateError).name).toBe('GenerationGateError');
      expect(thrown).toBeInstanceOf(Error);
    }
  });

  it('exposes current as a read-only getter', () => {
    const gate = new GenerationGate(2);
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(gate), 'current');
    expect(descriptor).toBeDefined();
    expect(typeof descriptor?.get).toBe('function');
    expect(descriptor?.set).toBeUndefined();
    expect(Reflect.set(gate, 'current', 99)).toBe(false);
    expect(gate.current).toBe(2);
  });
});

describe('GenerationGate: advance and accept', () => {
  it('advance increments by one, returns the new value and invalidates old generations', () => {
    const gate = new GenerationGate();
    expect(gate.advance()).toBe(1);
    expect(gate.current).toBe(1);
    expect(gate.accepts(0)).toBe(false);
    expect(gate.accepts(1)).toBe(true);
    expect(gate.advance()).toBe(2);
    expect(gate.accepts(1)).toBe(false);
    expect(gate.accepts(2)).toBe(true);
  });

  it('keeps advancing across consecutive cancellations without rolling back', () => {
    const gate = new GenerationGate(0);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) seen.push(gate.advance());
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(gate.current).toBe(5);
    for (const old of [0, 1, 2, 3, 4]) expect(gate.accepts(old)).toBe(false);
    expect(gate.accepts(5)).toBe(true);
  });

  it('accepts only the exact current safe integer', () => {
    const gate = new GenerationGate(10);
    for (const value of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 9, 11, Infinity]) {
      expect(gate.accepts(value)).toBe(false);
    }
    expect(gate.accepts(10)).toBe(true);
    // Runtime guard for callers arriving from untyped JavaScript.
    expect(gate.accepts('10' as unknown as number)).toBe(false);
    expect(gate.accepts(null as unknown as number)).toBe(false);
    expect(gate.accepts(undefined as unknown as number)).toBe(false);
  });

  it('keeps separate session gates independent', () => {
    const a = new GenerationGate();
    const b = new GenerationGate();
    a.advance();
    a.advance();
    expect(a.current).toBe(2);
    expect(b.current).toBe(0);
    expect(b.accepts(0)).toBe(true);
    expect(b.accepts(2)).toBe(false);
    b.advance();
    expect(a.current).toBe(2);
    expect(b.current).toBe(1);
    expect(a.accepts(2)).toBe(true);
    expect(b.accepts(2)).toBe(false);
  });
});

describe('GenerationGate: upper bound', () => {
  it('accepts the maximum generation without looping', () => {
    const gate = new GenerationGate(GENERATION_MAX);
    expect(gate.current).toBe(Number.MAX_SAFE_INTEGER);
    expect(gate.accepts(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(gate.accepts(Number.MAX_SAFE_INTEGER - 1)).toBe(false);
    expect(gate.accepts(0)).toBe(false);
  });

  it('rejects advance at the maximum and never wraps into an old generation', () => {
    const gate = new GenerationGate(GENERATION_MAX - 1);
    expect(gate.advance()).toBe(GENERATION_MAX);
    expect(gate.current).toBe(GENERATION_MAX);

    let thrown: unknown;
    try {
      gate.advance();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GenerationGateError);
    expect((thrown as GenerationGateError).code).toBe('GENERATION_EXHAUSTED');
    expect(gate.current).toBe(GENERATION_MAX);
    expect(gate.accepts(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(gate.accepts(0)).toBe(false);
    expect(gate.accepts(Number.MAX_SAFE_INTEGER - 1)).toBe(false);
  });
});
