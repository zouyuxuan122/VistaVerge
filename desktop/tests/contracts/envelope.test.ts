// FND-003 contract tests for the minimal cross-stage event envelope (v1).
//
// These tests define the public contract before the implementation exists. They
// exercise parseEnvelope(unknown) with a legal/illegal matrix and assert the
// discriminated result { ok: true, value } | { ok: false, code, path }.
//
// Security assertion: failures must never echo input content (including secrets)
// and must never place a user-controlled unknown field name into `path`.
import { describe, expect, it } from 'vitest';
import { parseEnvelope } from '../../../packages/contracts/src/envelope';
import type {
  EnvelopeErrorCode,
  EnvelopeParseFailure,
  EnvelopeParseResult,
  EnvelopeV1,
} from '../../../packages/contracts/src/envelope';

const TS = 1_700_000_000_000;

function validStarted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    type: 'turn.started',
    traceId: 'trace-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    generation: 0,
    seq: 0,
    emittedAt: TS,
    payload: { inputKind: 'text' },
    ...overrides,
  };
}

function validCancelled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    type: 'turn.cancelled',
    traceId: 'trace-2',
    sessionId: 'session-2',
    turnId: 'turn-2',
    generation: 3,
    seq: 7,
    emittedAt: TS + 5,
    payload: { reason: 'user' },
    ...overrides,
  };
}

function validDelta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    type: 'text.delta',
    traceId: 'trace-3',
    sessionId: 'session-3',
    turnId: 'turn-3',
    generation: 1,
    seq: 9,
    emittedAt: TS + 10,
    payload: { text: 'hello' },
    ...overrides,
  };
}

function expectOk(result: EnvelopeParseResult): EnvelopeV1 {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got ${result.code} at ${result.path}`);
  return result.value;
}

function expectFail(
  result: EnvelopeParseResult,
  code: EnvelopeErrorCode,
  path: string,
): EnvelopeParseFailure {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a parse failure, got ok');
  expect(result.code).toBe(code);
  expect(result.path).toBe(path);
  // The failure object is exactly { ok, code, path }: no echoed input, no value.
  expect(Object.keys(result).sort()).toEqual(['code', 'ok', 'path']);
  return result;
}

describe('parseEnvelope: legal v1 events', () => {
  it('accepts turn.started for both input kinds and returns exact public fields', () => {
    for (const inputKind of ['text', 'speech'] as const) {
      const value = expectOk(parseEnvelope(validStarted({ payload: { inputKind } })));
      expect(value.protocolVersion).toBe(1);
      expect(value.type).toBe('turn.started');
      expect(value.traceId).toBe('trace-1');
      expect(value.sessionId).toBe('session-1');
      expect(value.turnId).toBe('turn-1');
      expect(value.generation).toBe(0);
      expect(value.seq).toBe(0);
      expect(value.emittedAt).toBe(TS);
      expect(value.payload).toEqual({ inputKind });
      expect(Object.keys(value).sort()).toEqual([
        'emittedAt',
        'generation',
        'payload',
        'protocolVersion',
        'seq',
        'sessionId',
        'traceId',
        'turnId',
        'type',
      ]);
    }
  });

  it('accepts turn.cancelled for all four reasons', () => {
    for (const reason of ['user', 'stop', 'superseded', 'timeout'] as const) {
      const value = expectOk(parseEnvelope(validCancelled({ payload: { reason } })));
      expect(value.type).toBe('turn.cancelled');
      expect(value.payload).toEqual({ reason });
    }
  });

  it('accepts text.delta including the exact 16384-character boundary', () => {
    const short = expectOk(parseEnvelope(validDelta()));
    expect(short.type).toBe('text.delta');
    expect(short.payload).toEqual({ text: 'hello' });

    const max = 'x'.repeat(16384);
    const value = expectOk(parseEnvelope(validDelta({ payload: { text: max } })));
    expect(value.payload).toEqual({ text: max });
    expect((value.payload as { text: string }).text).toHaveLength(16384);
  });

  it('returns fresh objects (input object is not aliased into the result)', () => {
    const input = validStarted();
    const value = expectOk(parseEnvelope(input));
    expect(value).not.toBe(input);
    expect(value.payload).not.toBe(input.payload);
  });

  it('accepts boundary integers 0 and Number.MAX_SAFE_INTEGER and emittedAt 0', () => {
    const value = expectOk(
      parseEnvelope(validStarted({ generation: Number.MAX_SAFE_INTEGER, seq: 0, emittedAt: 0 })),
    );
    expect(value.generation).toBe(Number.MAX_SAFE_INTEGER);
    expect(value.seq).toBe(0);
    expect(value.emittedAt).toBe(0);
  });

  it('accepts a 128-character id boundary', () => {
    const id = 'a'.repeat(128);
    const value = expectOk(parseEnvelope(validStarted({ traceId: id })));
    expect(value.traceId).toHaveLength(128);
  });
});

describe('parseEnvelope: ids', () => {
  it('rejects each missing required id with MISSING_FIELD at the known path', () => {
    expectFail(parseEnvelope(validStarted({ traceId: undefined })), 'MISSING_FIELD', '$.traceId');
    expectFail(parseEnvelope(validStarted({ sessionId: undefined })), 'MISSING_FIELD', '$.sessionId');
    expectFail(parseEnvelope(validStarted({ turnId: undefined })), 'MISSING_FIELD', '$.turnId');
    const { turnId: _omitted, ...withoutTurnId } = validStarted();
    expectFail(parseEnvelope(withoutTurnId), 'MISSING_FIELD', '$.turnId');
  });

  it('rejects empty ids', () => {
    expectFail(parseEnvelope(validStarted({ traceId: '' })), 'INVALID_ID', '$.traceId');
    expectFail(parseEnvelope(validStarted({ sessionId: '' })), 'INVALID_ID', '$.sessionId');
    expectFail(parseEnvelope(validStarted({ turnId: '' })), 'INVALID_ID', '$.turnId');
  });

  it('accepts a whitespace-only id: v1 requires non-empty, not non-blank', () => {
    const value = expectOk(parseEnvelope(validStarted({ traceId: '   ' })));
    expect(value.traceId).toBe('   ');
  });

  it('rejects overlong ids (129 chars) and non-string ids', () => {
    const overlong = 'a'.repeat(129);
    expectFail(parseEnvelope(validStarted({ traceId: overlong })), 'INVALID_ID', '$.traceId');
    expectFail(parseEnvelope(validStarted({ sessionId: overlong })), 'INVALID_ID', '$.sessionId');
    expectFail(parseEnvelope(validStarted({ turnId: overlong })), 'INVALID_ID', '$.turnId');
    expectFail(parseEnvelope(validStarted({ traceId: 123 })), 'INVALID_ID', '$.traceId');
    expectFail(parseEnvelope(validStarted({ sessionId: {} })), 'INVALID_ID', '$.sessionId');
  });
});

describe('parseEnvelope: generation and seq', () => {
  it('rejects negative, NaN, fractional and over-safe-integer generation/seq', () => {
    const bad = [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, -Infinity, Infinity, '3', null];
    for (const value of bad) {
      expectFail(parseEnvelope(validStarted({ generation: value })), 'INVALID_INTEGER', '$.generation');
      expectFail(parseEnvelope(validStarted({ seq: value })), 'INVALID_INTEGER', '$.seq');
    }
  });

  it('rejects missing generation and seq', () => {
    expectFail(parseEnvelope(validStarted({ generation: undefined })), 'MISSING_FIELD', '$.generation');
    expectFail(parseEnvelope(validStarted({ seq: undefined })), 'MISSING_FIELD', '$.seq');
  });
});

describe('parseEnvelope: emittedAt', () => {
  it('rejects negative, non-finite and non-number timestamps', () => {
    for (const value of [-1, NaN, Infinity, -Infinity, '123', null, {}]) {
      expectFail(parseEnvelope(validStarted({ emittedAt: value })), 'INVALID_TIMESTAMP', '$.emittedAt');
    }
  });

  it('rejects a missing timestamp', () => {
    expectFail(parseEnvelope(validStarted({ emittedAt: undefined })), 'MISSING_FIELD', '$.emittedAt');
  });
});

describe('parseEnvelope: version and type', () => {
  it('rejects unknown or non-numeric protocol versions', () => {
    for (const value of [2, 0, '1', null, true]) {
      expectFail(
        parseEnvelope(validStarted({ protocolVersion: value })),
        'INVALID_PROTOCOL_VERSION',
        '$.protocolVersion',
      );
    }
    expectFail(parseEnvelope(validStarted({ protocolVersion: undefined })), 'MISSING_FIELD', '$.protocolVersion');
  });

  it('rejects unknown, non-string and missing event types', () => {
    for (const value of ['turn.finished', 'text.done', 'Turn.Started', 42, null, {}]) {
      expectFail(parseEnvelope(validStarted({ type: value })), 'INVALID_TYPE', '$.type');
    }
    expectFail(parseEnvelope(validStarted({ type: undefined })), 'MISSING_FIELD', '$.type');
  });
});

describe('parseEnvelope: exact fields and unknown-field rejection', () => {
  it('rejects a non-object input with NOT_OBJECT at the root', () => {
    for (const value of [null, undefined, 42, 'envelope', true, [], ['turn.started']]) {
      expectFail(parseEnvelope(value), 'NOT_OBJECT', '$');
    }
  });

  it('rejects a top-level extra field without echoing its name or value', () => {
    const secretName = 'secret';
    const secretValue = 'sk-live-DO-NOT-ECHO-7f3c';
    const result = expectFail(
      parseEnvelope({ ...validStarted(), [secretName]: secretValue }),
      'UNKNOWN_FIELD',
      '$',
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain(secretName);
    expect(result.path).not.toContain(secretName);
  });

  it('rejects an extra payload field without echoing its name or value', () => {
    const secretValue = 'SUPER_SECRET_TOKEN_9f3a';
    const result = expectFail(
      parseEnvelope(validDelta({ payload: { text: 'ok', secret: secretValue } })),
      'UNKNOWN_FIELD',
      '$.payload',
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain('secret');
    expect(result.path).not.toContain('secret');
  });

  it('does not echo an overlong secret payload text in the error', () => {
    const secret = 'sk-live-DO-NOT-ECHO-7f3c';
    const result = expectFail(
      parseEnvelope(validDelta({ payload: { text: secret.repeat(700) } })),
      'INVALID_PAYLOAD',
      '$.payload.text',
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('parseEnvelope: payload validation', () => {
  it('rejects a missing or non-object payload', () => {
    expectFail(parseEnvelope(validStarted({ payload: undefined })), 'MISSING_FIELD', '$.payload');
    for (const payload of [null, 'text', 42, [], true]) {
      expectFail(parseEnvelope(validStarted({ payload })), 'INVALID_PAYLOAD', '$.payload');
    }
  });

  it('rejects an invalid turn.started inputKind', () => {
    for (const inputKind of ['audio', 'TEXT', '', 1, null, undefined, {}]) {
      expectFail(
        parseEnvelope(validStarted({ payload: { inputKind } })),
        inputKind === undefined ? 'MISSING_FIELD' : 'INVALID_PAYLOAD',
        '$.payload.inputKind',
      );
    }
  });

  it('rejects an invalid turn.cancelled reason', () => {
    for (const reason of ['cancel', 'USER', '', 3, null, undefined]) {
      expectFail(
        parseEnvelope(validCancelled({ payload: { reason } })),
        reason === undefined ? 'MISSING_FIELD' : 'INVALID_PAYLOAD',
        '$.payload.reason',
      );
    }
  });

  it('rejects empty, non-string and overlong text.delta text', () => {
    expectFail(parseEnvelope(validDelta({ payload: { text: '' } })), 'INVALID_PAYLOAD', '$.payload.text');
    expectFail(parseEnvelope(validDelta({ payload: { text: 'x'.repeat(16385) } })), 'INVALID_PAYLOAD', '$.payload.text');
    for (const text of [1, null, {}, [], true, undefined]) {
      expectFail(
        parseEnvelope(validDelta({ payload: { text } })),
        text === undefined ? 'MISSING_FIELD' : 'INVALID_PAYLOAD',
        '$.payload.text',
      );
    }
  });

  it('rejects a missing known payload field as MISSING_FIELD', () => {
    expectFail(parseEnvelope(validStarted({ payload: {} })), 'MISSING_FIELD', '$.payload.inputKind');
    expectFail(parseEnvelope(validCancelled({ payload: {} })), 'MISSING_FIELD', '$.payload.reason');
    expectFail(parseEnvelope(validDelta({ payload: {} })), 'MISSING_FIELD', '$.payload.text');
  });
});
