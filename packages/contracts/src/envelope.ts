// FND-003 minimal cross-stage event envelope contract, version 1.
//
// Pure, dependency-free, JSON-data schema validation for exactly three
// turn-class events. It is intentionally NOT wired into any runtime yet (see
// ../README.md). It does not check global time ordering and it does not attempt
// to isolate untrusted JavaScript getters; the input is treated as JSON data.
//
// Parsing contract:
//   parseEnvelope(unknown) ->
//     { ok: true, value: EnvelopeV1 }
//   | { ok: false, code: EnvelopeErrorCode, path: string }
//
// Failure objects contain only a static code and a path built from KNOWN field
// names (or the container for an unknown field). They never echo input values
// and never place a user-controlled unknown field name into `path`.

/** Wire-protocol major version discriminator for this envelope family. */
export const ENVELOPE_PROTOCOL_VERSION = 1 as const;

/** Maximum length of traceId / sessionId / turnId. */
export const ENVELOPE_MAX_ID_LENGTH = 128;

/** Inclusive length bounds for text.delta payload text. */
export const TEXT_DELTA_MIN_LENGTH = 1;
export const TEXT_DELTA_MAX_LENGTH = 16384;

export type InputKind = 'text' | 'speech';
export type CancelReason = 'user' | 'stop' | 'superseded' | 'timeout';
export type EnvelopeType = 'turn.started' | 'turn.cancelled' | 'text.delta';

export interface TurnStartedPayload {
  readonly inputKind: InputKind;
}
export interface TurnCancelledPayload {
  readonly reason: CancelReason;
}
export interface TextDeltaPayload {
  readonly text: string;
}

export interface EnvelopeBase {
  readonly protocolVersion: 1;
  readonly traceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly generation: number;
  readonly seq: number;
  readonly emittedAt: number;
}

export interface TurnStartedEnvelope extends EnvelopeBase {
  readonly type: 'turn.started';
  readonly payload: TurnStartedPayload;
}
export interface TurnCancelledEnvelope extends EnvelopeBase {
  readonly type: 'turn.cancelled';
  readonly payload: TurnCancelledPayload;
}
export interface TextDeltaEnvelope extends EnvelopeBase {
  readonly type: 'text.delta';
  readonly payload: TextDeltaPayload;
}

export type EnvelopeV1 = TurnStartedEnvelope | TurnCancelledEnvelope | TextDeltaEnvelope;

export type EnvelopeErrorCode =
  | 'NOT_OBJECT'
  | 'UNKNOWN_FIELD'
  | 'MISSING_FIELD'
  | 'INVALID_PROTOCOL_VERSION'
  | 'INVALID_TYPE'
  | 'INVALID_ID'
  | 'INVALID_INTEGER'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_PAYLOAD';

export interface EnvelopeParseFailure {
  readonly ok: false;
  readonly code: EnvelopeErrorCode;
  /**
   * Location of the failure. For known fields this is a JSON-pointer-like path
   * such as `$.traceId` or `$.payload.text`. For an unknown/extra field it is
   * the containing object (`$` or `$.payload`), never the attacker-controlled
   * key name.
   */
  readonly path: string;
}

export type EnvelopeParseResult =
  | { readonly ok: true; readonly value: EnvelopeV1 }
  | EnvelopeParseFailure;

const ROOT = '$';
const TOP_LEVEL_KEYS: readonly string[] = [
  'protocolVersion',
  'type',
  'traceId',
  'sessionId',
  'turnId',
  'generation',
  'seq',
  'emittedAt',
  'payload',
];
const STARTED_KEYS: readonly string[] = ['inputKind'];
const CANCELLED_KEYS: readonly string[] = ['reason'];
const DELTA_KEYS: readonly string[] = ['text'];

function fail(code: EnvelopeErrorCode, path: string): EnvelopeParseFailure {
  return { ok: false, code, path };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return true;
  }
  return false;
}

function isEnvelopeType(value: unknown): value is EnvelopeType {
  return value === 'turn.started' || value === 'turn.cancelled' || value === 'text.delta';
}

function isInputKind(value: unknown): value is InputKind {
  return value === 'text' || value === 'speech';
}

function isCancelReason(value: unknown): value is CancelReason {
  return value === 'user' || value === 'stop' || value === 'superseded' || value === 'timeout';
}

function parseId(
  input: Record<string, unknown>,
  key: 'traceId' | 'sessionId' | 'turnId',
): { ok: true; value: string } | EnvelopeParseFailure {
  const value = input[key];
  if (value === undefined) return fail('MISSING_FIELD', `$.${key}`);
  if (typeof value !== 'string' || value.length === 0 || value.length > ENVELOPE_MAX_ID_LENGTH) {
    return fail('INVALID_ID', `$.${key}`);
  }
  return { ok: true, value };
}

function parseInteger(
  input: Record<string, unknown>,
  key: 'generation' | 'seq',
): { ok: true; value: number } | EnvelopeParseFailure {
  const value = input[key];
  if (value === undefined) return fail('MISSING_FIELD', `$.${key}`);
  if (!isNonNegativeSafeInteger(value)) return fail('INVALID_INTEGER', `$.${key}`);
  return { ok: true, value };
}

/**
 * Parse an unknown value into an EnvelopeV1 or a coded failure.
 * Rejects unknown protocol versions, unknown types, unknown/extra fields and
 * malformed payloads. Extra fields are rejected by design in v1.
 */
export function parseEnvelope(input: unknown): EnvelopeParseResult {
  if (!isPlainRecord(input)) return fail('NOT_OBJECT', ROOT);
  if (hasUnknownKeys(input, TOP_LEVEL_KEYS)) return fail('UNKNOWN_FIELD', ROOT);

  if (input.protocolVersion === undefined) return fail('MISSING_FIELD', '$.protocolVersion');
  if (input.protocolVersion !== ENVELOPE_PROTOCOL_VERSION) {
    return fail('INVALID_PROTOCOL_VERSION', '$.protocolVersion');
  }

  const type = input.type;
  if (type === undefined) return fail('MISSING_FIELD', '$.type');
  if (!isEnvelopeType(type)) return fail('INVALID_TYPE', '$.type');

  const traceId = parseId(input, 'traceId');
  if (!traceId.ok) return traceId;
  const sessionId = parseId(input, 'sessionId');
  if (!sessionId.ok) return sessionId;
  const turnId = parseId(input, 'turnId');
  if (!turnId.ok) return turnId;

  const generation = parseInteger(input, 'generation');
  if (!generation.ok) return generation;
  const seq = parseInteger(input, 'seq');
  if (!seq.ok) return seq;

  const emittedAt = input.emittedAt;
  if (emittedAt === undefined) return fail('MISSING_FIELD', '$.emittedAt');
  if (typeof emittedAt !== 'number' || !Number.isFinite(emittedAt) || emittedAt < 0) {
    return fail('INVALID_TIMESTAMP', '$.emittedAt');
  }

  const payload = input.payload;
  if (payload === undefined) return fail('MISSING_FIELD', '$.payload');
  if (!isPlainRecord(payload)) return fail('INVALID_PAYLOAD', '$.payload');

  const base = {
    protocolVersion: ENVELOPE_PROTOCOL_VERSION,
    traceId: traceId.value,
    sessionId: sessionId.value,
    turnId: turnId.value,
    generation: generation.value,
    seq: seq.value,
    emittedAt,
  };

  if (type === 'turn.started') {
    if (hasUnknownKeys(payload, STARTED_KEYS)) return fail('UNKNOWN_FIELD', '$.payload');
    const inputKind = payload.inputKind;
    if (inputKind === undefined) return fail('MISSING_FIELD', '$.payload.inputKind');
    if (!isInputKind(inputKind)) return fail('INVALID_PAYLOAD', '$.payload.inputKind');
    return { ok: true, value: { ...base, type, payload: { inputKind } } };
  }

  if (type === 'turn.cancelled') {
    if (hasUnknownKeys(payload, CANCELLED_KEYS)) return fail('UNKNOWN_FIELD', '$.payload');
    const reason = payload.reason;
    if (reason === undefined) return fail('MISSING_FIELD', '$.payload.reason');
    if (!isCancelReason(reason)) return fail('INVALID_PAYLOAD', '$.payload.reason');
    return { ok: true, value: { ...base, type, payload: { reason } } };
  }

  if (hasUnknownKeys(payload, DELTA_KEYS)) return fail('UNKNOWN_FIELD', '$.payload');
  const text = payload.text;
  if (text === undefined) return fail('MISSING_FIELD', '$.payload.text');
  if (typeof text !== 'string') return fail('INVALID_PAYLOAD', '$.payload.text');
  if (text.length < TEXT_DELTA_MIN_LENGTH || text.length > TEXT_DELTA_MAX_LENGTH) {
    return fail('INVALID_PAYLOAD', '$.payload.text');
  }
  return { ok: true, value: { ...base, type, payload: { text } } };
}
