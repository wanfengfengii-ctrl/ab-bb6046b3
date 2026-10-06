import { describe, expect, it } from 'vitest';
import { auditTraces } from '../src/audit.js';
import type { InputSpan } from '../src/audit.js';

let seq = 0;
function span(
  partial: Partial<InputSpan> & Pick<InputSpan, 'service' | 'startUs' | 'endUs'>,
): InputSpan {
  seq += 1;
  return {
    spanId: `s${seq}`,
    parentSpanId: null,
    ...partial,
  };
}

describe('auditTraces - structural validation', () => {
  const expectCode = (body: unknown, code: string) => {
    try {
      auditTraces(body);
    } catch (err) {
      expect((err as { auditError?: { code: string } }).auditError?.code).toBe(code);
      return;
    }
    throw new Error(`expected auditTraces to throw ${code}`);
  };

  it('rejects a non-object body', () => {
    expectCode(null, 'invalid_body');
    expectCode([], 'invalid_body');
    expectCode('x', 'invalid_body');
  });

  it('rejects bad maxClockSkewUs', () => {
    expectCode({ maxClockSkewUs: -1, spans: [] }, 'invalid_max_clock_skew');
    expectCode({ maxClockSkewUs: 1.5, spans: [] }, 'invalid_max_clock_skew');
    expectCode({ maxClockSkewUs: '5', spans: [] }, 'invalid_max_clock_skew');
  });

  it('rejects empty or oversized span arrays', () => {
    expectCode({ maxClockSkewUs: 0, spans: [] }, 'invalid_spans');
    const many = Array.from({ length: 501 }, (_, i) => ({
      spanId: `x${i}`,
      service: 'a',
      parentSpanId: null,
      startUs: 0,
      endUs: 1,
    }));
    expectCode({ maxClockSkewUs: 0, spans: many }, 'invalid_spans');
  });

  it('accepts exactly 500 spans', () => {
    const spans = Array.from({ length: 500 }, (_, i) => ({
      spanId: `x${i}`,
      service: 'a',
      parentSpanId: i === 0 ? null : `x${i - 1}`,
      startUs: 0,
      endUs: 1000,
    }));
    expect(auditTraces({ maxClockSkewUs: 0, spans })).toEqual({
      valid: true,
      spanCount: 500,
      serviceCount: 1,
    });
  });

  it('rejects malformed span fields', () => {
    expectCode(
      { maxClockSkewUs: 0, spans: [{ spanId: '', service: 'a', parentSpanId: null, startUs: 0, endUs: 1 }] },
      'invalid_span',
    );
    expectCode(
      { maxClockSkewUs: 0, spans: [{ spanId: 'a', service: '', parentSpanId: null, startUs: 0, endUs: 1 }] },
      'invalid_span',
    );
    expectCode(
      { maxClockSkewUs: 0, spans: [{ spanId: 'a', service: 'x', parentSpanId: 1, startUs: 0, endUs: 1 }] },
      'invalid_span',
    );
    expectCode(
      { maxClockSkewUs: 0, spans: [{ spanId: 'a', service: 'x', startUs: 0, endUs: 1 }] },
      'invalid_span',
    );
  });

  it('rejects zero-length and inverted spans', () => {
    expectCode(
      { maxClockSkewUs: 0, spans: [{ spanId: 'a', service: 'x', parentSpanId: null, startUs: 5, endUs: 5 }] },
      'invalid_span',
    );
    expectCode(
      { maxClockSkewUs: 0, spans: [{ spanId: 'a', service: 'x', parentSpanId: null, startUs: 6, endUs: 5 }] },
      'invalid_span',
    );
  });

  it('rejects duplicate span ids', () => {
    const spans = [
      { spanId: 'a', service: 'x', parentSpanId: null, startUs: 0, endUs: 10 },
      { spanId: 'a', service: 'y', parentSpanId: 'a', startUs: 1, endUs: 9 },
    ];
    expectCode({ maxClockSkewUs: 0, spans }, 'duplicate_span_id');
  });

  it('rejects unknown parent references', () => {
    const spans = [
      { spanId: 'a', service: 'x', parentSpanId: 'ghost', startUs: 0, endUs: 10 },
    ];
    expectCode({ maxClockSkewUs: 0, spans }, 'unknown_parent');
  });

  it('rejects multiple roots', () => {
    const spans = [
      { spanId: 'a', service: 'x', parentSpanId: null, startUs: 0, endUs: 10 },
      { spanId: 'b', service: 'y', parentSpanId: null, startUs: 0, endUs: 10 },
    ];
    expectCode({ maxClockSkewUs: 0, spans }, 'multiple_roots');
  });

  it('rejects no root (cycle)', () => {
    const spans = [
      { spanId: 'a', service: 'x', parentSpanId: 'b', startUs: 0, endUs: 10 },
      { spanId: 'b', service: 'y', parentSpanId: 'a', startUs: 0, endUs: 10 },
    ];
    expectCode({ maxClockSkewUs: 0, spans }, 'no_root');
  });

  it('rejects a detached cycle alongside a valid root tree', () => {
    const spans = [
      { spanId: 'r', service: 'x', parentSpanId: null, startUs: 0, endUs: 100 },
      { spanId: 'a', service: 'x', parentSpanId: 'b', startUs: 0, endUs: 10 },
      { spanId: 'b', service: 'x', parentSpanId: 'a', startUs: 0, endUs: 10 },
    ];
    expectCode({ maxClockSkewUs: 0, spans }, 'cycle_detected');
  });
});

describe('auditTraces - temporal feasibility', () => {
  it('single root span is valid regardless of skew', () => {
    const spans = [span({ service: 'svc-a', startUs: 100, endUs: 200 })];
    expect(auditTraces({ maxClockSkewUs: 0, spans })).toEqual({
      valid: true,
      spanCount: 1,
      serviceCount: 1,
    });
  });

  it('well-nested trace with zero skew is valid', () => {
    const root = span({ spanId: 'r', service: 'gw', startUs: 0, endUs: 1000 });
    const child = span({ spanId: 'c', service: 'calc', parentSpanId: 'r', startUs: 100, endUs: 900 });
    expect(auditTraces({ maxClockSkewUs: 0, spans: [root, child] })).toEqual({
      valid: true,
      spanCount: 2,
      serviceCount: 2,
    });
  });

  it('child overflowing parent by 10us: invalid with no room, valid once 2*skew covers the 10us relative shift', () => {
    seq = 0;
    const root = { spanId: 'r', service: 'gw', parentSpanId: null, startUs: 0, endUs: 100 };
    const child = { spanId: 'c', service: 'calc', parentSpanId: 'r', startUs: 10, endUs: 110 };

    expect(auditTraces({ maxClockSkewUs: 0, spans: [root, child] })).toMatchObject({
      valid: false,
      reason: 'temporal_inconsistent',
      spanCount: 2,
      serviceCount: 2,
    });
    // 2*4 = 8 < 10: cannot correct
    expect(auditTraces({ maxClockSkewUs: 4, spans: [root, child] })).toMatchObject({
      valid: false,
      reason: 'temporal_inconsistent',
    });
    // 2*5 = 10: o_gw=+5, o_calc=-5 makes both corrected spans [5,105]
    expect(auditTraces({ maxClockSkewUs: 5, spans: [root, child] })).toEqual({
      valid: true,
      spanCount: 2,
      serviceCount: 2,
    });
  });

  it('same-service inversion cannot be corrected by any skew', () => {
    seq = 0;
    const root = { spanId: 'r', service: 'svc', parentSpanId: null, startUs: 100, endUs: 200 };
    const child = { spanId: 'c', service: 'svc', parentSpanId: 'r', startUs: 210, endUs: 220 };
    expect(auditTraces({ maxClockSkewUs: 1_000_000, spans: [root, child] })).toMatchObject({
      valid: false,
      reason: 'temporal_inconsistent',
    });
  });

  it('multi-service cycle whose required offset spread exceeds the skew is temporal_inconsistent', () => {
    seq = 0;
    // Tree: r(A) -> b(B) -> a2(A). The A-B-A round trip forces
    // 1500 <= o_A - o_B <= 3000 (consistent!), which is realizable only when
    // 2*maxClockSkewUs >= 1500. Structure is fine; failure is purely temporal.
    const r = { spanId: 'r', service: 'A', parentSpanId: null, startUs: -3000, endUs: 100000 };
    const b = { spanId: 'b', service: 'B', parentSpanId: 'r', startUs: 0, endUs: 90000 };
    const a2 = { spanId: 'a2', service: 'A', parentSpanId: 'b', startUs: -1500, endUs: 1000 };

    const at100 = auditTraces({ maxClockSkewUs: 100, spans: [r, b, a2] });
    expect(at100).toMatchObject({ valid: false, reason: 'temporal_inconsistent' });
    expect(at100.spanCount).toBe(3);
    expect(at100.serviceCount).toBe(2);

    // 2*749 < 1500
    expect(auditTraces({ maxClockSkewUs: 749, spans: [r, b, a2] }).valid).toBe(false);
    // 2*750 >= 1500, e.g. o_A=750, o_B=-750
    expect(auditTraces({ maxClockSkewUs: 750, spans: [r, b, a2] }).valid).toBe(true);
  });

  it('a large enough skew makes the shifted trace valid (no false inversion report)', () => {
    seq = 0;
    const r = { spanId: 'r', service: 'A', parentSpanId: null, startUs: -3000, endUs: 100000 };
    const b = { spanId: 'b', service: 'B', parentSpanId: 'r', startUs: 0, endUs: 90000 };
    const a2 = { spanId: 'a2', service: 'A', parentSpanId: 'b', startUs: -1500, endUs: 1000 };
    expect(auditTraces({ maxClockSkewUs: 1000, spans: [r, b, a2] })).toEqual({
      valid: true,
      spanCount: 3,
      serviceCount: 2,
    });
  });

  it('negative timestamps are allowed', () => {
    seq = 0;
    const root = { spanId: 'r', service: 'a', parentSpanId: null, startUs: -500, endUs: 500 };
    const child = { spanId: 'c', service: 'b', parentSpanId: 'r', startUs: -400, endUs: 400 };
    expect(auditTraces({ maxClockSkewUs: 0, spans: [root, child] }).valid).toBe(true);
  });
});
