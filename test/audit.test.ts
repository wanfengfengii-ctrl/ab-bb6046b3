import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditTrace, MAX_SPANS } from "../src/audit.js";

interface SpanInput {
  spanId: string;
  service: string;
  parentSpanId?: string | null;
  startUs: number;
  endUs: number;
}

function body(spans: SpanInput[], maxClockSkewUs = 0): Record<string, unknown> {
  return { maxClockSkewUs, spans };
}

function expectError(input: unknown, code: string): void {
  const outcome = auditTrace(input);
  assert.equal(outcome.ok, false, `expected error ${code}, got ${JSON.stringify(outcome)}`);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, code);
}

describe("auditTrace - structural validation", () => {
  it("accepts a single root span", () => {
    const outcome = auditTrace(body([{ spanId: "a", service: "s1", startUs: 0, endUs: 10 }]));
    assert.deepEqual(outcome, {
      ok: true,
      result: { spanCount: 1, serviceCount: 1, valid: true },
    });
  });

  it("rejects non-object bodies", () => {
    expectError(null, "invalid_request");
    expectError([], "invalid_request");
    expectError("nope", "invalid_request");
  });

  it("rejects bad maxClockSkewUs", () => {
    expectError(body([], 0.5), "invalid_max_clock_skew");
    expectError(body([], -1), "invalid_max_clock_skew");
    expectError({ maxClockSkewUs: "10", spans: [] }, "invalid_max_clock_skew");
    expectError({ spans: [] }, "invalid_max_clock_skew");
  });

  it("rejects out-of-range span arrays", () => {
    expectError(body([]), "invalid_spans");
    const many = Array.from({ length: MAX_SPANS + 1 }, (_, i) => ({
      spanId: `s${i}`,
      service: "x",
      parentSpanId: i === 0 ? null : `s${i - 1}`,
      startUs: i,
      endUs: i + 2,
    }));
    expectError(body(many), "invalid_spans");
  });

  it("rejects malformed span fields", () => {
    expectError(
      body([{ spanId: "", service: "s", startUs: 0, endUs: 1 }]),
      "invalid_span_id",
    );
    expectError(
      body([{ spanId: "a", service: "", startUs: 0, endUs: 1 }]),
      "invalid_service",
    );
    expectError(
      {
        maxClockSkewUs: 0,
        spans: [{ spanId: "a", service: "s", parentSpanId: 7, startUs: 0, endUs: 1 }],
      },
      "invalid_parent_span_id",
    );
    expectError(
      body([{ spanId: "a", service: "s", startUs: 1.5, endUs: 2 }]),
      "invalid_timestamp",
    );
    expectError(
      {
        maxClockSkewUs: 0,
        spans: [{ spanId: "a", service: "s", startUs: "a", endUs: 2 }],
      },
      "invalid_timestamp",
    );
    expectError(
      body([{ spanId: "a", service: "s", startUs: 2, endUs: Number.MAX_SAFE_INTEGER + 1 }]),
      "invalid_timestamp",
    );
    expectError({ maxClockSkewUs: 0, spans: ["junk"] }, "invalid_span");
  });

  it("rejects spans that do not start before they end", () => {
    expectError(
      body([
        { spanId: "a", service: "s", startUs: 5, endUs: 5 },
      ]),
      "invalid_span_interval",
    );
    expectError(
      body([
        { spanId: "a", service: "s", startUs: 6, endUs: 5 },
      ]),
      "invalid_span_interval",
    );
  });

  it("rejects duplicate span ids", () => {
    expectError(
      body([
        { spanId: "a", service: "s", startUs: 0, endUs: 1 },
        { spanId: "a", service: "s", startUs: 1, endUs: 2 },
      ]),
      "duplicate_span_id",
    );
  });

  it("rejects dangling parent references", () => {
    expectError(
      body([
        { spanId: "a", service: "s", parentSpanId: "ghost", startUs: 0, endUs: 1 },
      ]),
      "parent_span_not_found",
    );
  });

  it("rejects zero or multiple roots", () => {
    expectError(
      body([
        { spanId: "a", service: "s", parentSpanId: "b", startUs: 0, endUs: 2 },
        { spanId: "b", service: "s", parentSpanId: "a", startUs: 0, endUs: 2 },
      ]),
      "no_root_span",
    );
    expectError(
      body([
        { spanId: "a", service: "s", startUs: 0, endUs: 2 },
        { spanId: "b", service: "s", startUs: 0, endUs: 2 },
      ]),
      "multiple_root_spans",
    );
  });

  it("rejects cycles and disconnected components", () => {
    expectError(
      body([
        { spanId: "r", service: "s", startUs: 0, endUs: 100 },
        { spanId: "a", service: "s", parentSpanId: "b", startUs: 0, endUs: 10 },
        { spanId: "b", service: "s", parentSpanId: "a", startUs: 0, endUs: 10 },
      ]),
      "span_graph_cycle",
    );
    expectError(
      body([
        { spanId: "a", service: "s", parentSpanId: "a", startUs: 0, endUs: 10 },
      ]),
      "no_root_span",
    );
  });
});

describe("auditTrace - temporal causality", () => {
  it("accepts a well-formed nested tree without skew", () => {
    const outcome = auditTrace(
      body([
        { spanId: "r", service: "gateway", startUs: 0, endUs: 1000 },
        { spanId: "a", service: "auth", parentSpanId: "r", startUs: 10, endUs: 500 },
        { spanId: "b", service: "billing", parentSpanId: "r", startUs: 200, endUs: 900 },
        { spanId: "c", service: "auth", parentSpanId: "b", startUs: 210, endUs: 400 },
      ]),
    );
    assert.deepEqual(outcome.ok && outcome.result, {
      spanCount: 4,
      serviceCount: 3,
      valid: true,
    });
  });

  it("accepts boundary-aligned containment", () => {
    const outcome = auditTrace(
      body([
        { spanId: "p", service: "s1", startUs: 0, endUs: 100 },
        { spanId: "q", service: "s1", parentSpanId: "p", startUs: 0, endUs: 100 },
      ]),
    );
    assert.equal(outcome.ok && outcome.result.valid, true);
  });

  it("corrects a child whose clock is ahead within the skew budget", () => {
    // Child clock runs 50us fast; recorded interval sits 50us to the right.
    // Feasibility needs o(parent)-o(child) = 50, requiring K >= 25.
    const spans = [
      { spanId: "p", service: "s1", startUs: 1000, endUs: 2000 },
      { spanId: "q", service: "s2", parentSpanId: "p", startUs: 1050, endUs: 2050 },
    ];
    const at0 = auditTrace(body(spans, 0));
    assert.equal(at0.ok && at0.result.valid, false);
    const tight = auditTrace(body(spans, 24));
    assert.equal(tight.ok && tight.result.valid, false);
    const exact = auditTrace(body(spans, 25));
    assert.equal(exact.ok && exact.result.valid, true);
    const outcome = auditTrace(body(spans, 100));
    assert.equal(outcome.ok && outcome.result.valid, true);
  });

  it("flags the same trace when skew budget is too small", () => {
    const spans = [
      { spanId: "p", service: "s1", startUs: 1000, endUs: 2000 },
      { spanId: "q", service: "s2", parentSpanId: "p", startUs: 1050, endUs: 2050 },
    ];
    const outcome = auditTrace(body(spans, 20));
    assert.deepEqual(outcome.ok && outcome.result, {
      spanCount: 2,
      serviceCount: 2,
      valid: false,
      reason: "temporal_inconsistent",
    });
  });

  it("cannot fix violations inside one service with any skew", () => {
    // Same service shares one offset, so offset corrections cancel out.
    const spans = [
      { spanId: "p", service: "s1", startUs: 100, endUs: 200 },
      { spanId: "q", service: "s1", parentSpanId: "p", startUs: 150, endUs: 250 },
    ];
    const outcome = auditTrace(body(spans, 1_000_000));
    assert.deepEqual(outcome.ok && outcome.result, {
      spanCount: 2,
      serviceCount: 1,
      valid: false,
      reason: "temporal_inconsistent",
    });
  });

  it("cannot fix a child span longer than its parent, regardless of skew", () => {    const spans = [
      { spanId: "p", service: "s1", startUs: 0, endUs: 10 },
      { spanId: "q", service: "s2", parentSpanId: "p", startUs: 0, endUs: 20 },
    ];
    const outcome = auditTrace(body(spans, 1_000_000));
    assert.equal(outcome.ok && outcome.result.valid, false);
    assert.equal(outcome.ok && outcome.result.reason, "temporal_inconsistent");
  });

  it("accepts a three-service chain whose offsets only compose globally", () => {
    // Each edge needs roughly 900us of cumulative shift; a greedy per-pair
    // check with a shared 1000us bound per service still succeeds because the
    // chain has no service reuse, so offsets simply add up.
    const spans = [
      { spanId: "a", service: "A", startUs: 0, endUs: 1000 },
      { spanId: "b", service: "B", parentSpanId: "a", startUs: 900, endUs: 1900 },
      { spanId: "c", service: "C", parentSpanId: "b", startUs: 1800, endUs: 2100 },
    ];
    // o(b)-o(a)=-900, o(c)-o(b) in [-900,-200]; choose o(c)-o(b)=-200.
    const tight = auditTrace(body(spans, 900));
    assert.equal(tight.ok && tight.result.valid, true);
  });

  it("shares one offset across sibling spans of the same service", () => {
    // Two children in service B demand contradictory shifts vs parent A:
    // b1 recorded earlier => needs shifting later, b2 recorded later by a
    // larger margin => needs shifting earlier. One offset cannot do both.
    const spans = [
      { spanId: "p", service: "A", startUs: 1000, endUs: 2000 },
      { spanId: "b1", service: "B", parentSpanId: "p", startUs: 900, endUs: 1100 },
      { spanId: "b2", service: "B", parentSpanId: "p", startUs: 1950, endUs: 2150 },
    ];
    // b1 start forces o(B)-o(A) >= 100; b2 end forces o(B)-o(A) <= -150.
    const outcome = auditTrace(body(spans, 1_000_000));
    assert.equal(outcome.ok && outcome.result.valid, false);
    assert.equal(outcome.ok && outcome.result.reason, "temporal_inconsistent");
  });

  it("requires one consistent offset per service across all its spans", () => {
    // Service A appears both as root (a1) and as grandchild (a2). Let
    // d = o(B) - o(A). Start containment of a1 -> b1 forces d >= -900, while
    // start containment of b1 -> a2 forces d <= -1000. No d satisfies both,
    // independent of the skew bound (negative A-B cycle in the graph).
    const spans = [
      { spanId: "a1", service: "A", startUs: 0, endUs: 1000 },
      { spanId: "b1", service: "B", parentSpanId: "a1", startUs: 900, endUs: 1100 },
      { spanId: "a2", service: "A", parentSpanId: "b1", startUs: -100, endUs: 100 },
    ];
    const outcome = auditTrace(body(spans, 1_000_000));
    assert.equal(outcome.ok && outcome.result.valid, false);
    assert.equal(outcome.ok && outcome.result.reason, "temporal_inconsistent");
  });

  it("handles negative and large integer timestamps exactly", () => {
    const spans = [
      { spanId: "p", service: "s1", startUs: -1_000_000_000_000, endUs: 1_000_000_000_000 },
      {
        spanId: "q",
        service: "s2",
        parentSpanId: "p",
        startUs: Number.MAX_SAFE_INTEGER - 1,
        endUs: Number.MAX_SAFE_INTEGER,
      },
    ];
    // Required relative shift is about 8.0e15 us; an 8.5e15 budget covers it.
    const tooSmall = auditTrace(body(spans, 10_000_000_000_000));
    assert.equal(tooSmall.ok && tooSmall.result.valid, false);
    const outcome = auditTrace(body(spans, Number.MAX_SAFE_INTEGER));
    assert.deepEqual(outcome.ok && outcome.result, {
      spanCount: 2,
      serviceCount: 2,
      valid: true,
    });
  });

  it("accepts a deeply nested 500-span tree", () => {
    // Each span strictly nests inside its parent; each span has its own service.
    const n = MAX_SPANS;
    const spans: SpanInput[] = Array.from({ length: n }, (_, i) => ({
      spanId: `s${i}`,
      service: `svc${i}`,
      parentSpanId: i === 0 ? null : `s${i - 1}`,
      startUs: i,
      endUs: 2 * n - i,
    }));
    const outcome = auditTrace(body(spans, 0));
    assert.equal(outcome.ok && outcome.result.spanCount, n);
    assert.equal(outcome.ok && outcome.result.serviceCount, n);
    assert.equal(outcome.ok && outcome.result.valid, true);
  });

  it("reports infeasibility on a long same-service chain", () => {
    // All spans share one service; recorded intervals drift rightward, which no
    // single offset can repair.
    const n = MAX_SPANS;
    const spans: SpanInput[] = Array.from({ length: n }, (_, i) => ({
      spanId: `s${i}`,
      service: "only",
      parentSpanId: i === 0 ? null : `s${i - 1}`,
      startUs: i * 10,
      endUs: i * 10 + 5,
    }));
    // span i (i>0) starts 10us after its parent's start but ends 10us after
    // the parent ends - impossible within one clock domain at any skew.
    const outcome = auditTrace(body(spans, 1_000_000));
    assert.equal(outcome.ok && outcome.result.valid, false);
    assert.equal(outcome.ok && outcome.result.reason, "temporal_inconsistent");
  });
});
