import { ErrorCode, ValidationFailure } from './errors.js';
import { offsetsFeasible, type ParentContainmentEdge } from './clockSolver.js';

export interface InputSpan {
  spanId: string;
  service: string;
  parentSpanId: string | null;
  startUs: number;
  endUs: number;
}

export interface AuditResponse {
  valid: boolean;
  spanCount: number;
  serviceCount: number;
  reason?: 'temporal_inconsistent';
}

const MIN_SPANS = 1;
const MAX_SPANS = 500;

function fail(
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new ValidationFailure({ code, message, details });
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNullableSpanId(v: unknown): v is string | null {
  return v === null || isNonEmptyString(v);
}

/**
 * Validates the request payload and decides whether one integer clock offset
 * per service (within +/- maxClockSkewUs) can make every corrected child span
 * lie completely inside its corrected parent span.
 */
export function auditTraces(rawBody: unknown): AuditResponse {
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
    fail(ErrorCode.INVALID_BODY, 'Request body must be a JSON object.');
  }
  const body = rawBody as Record<string, unknown>;

  // --- maxClockSkewUs: required, non-negative integer ---------------------
  const skew = body.maxClockSkewUs;
  if (
    typeof skew !== 'number' ||
    !Number.isSafeInteger(skew) ||
    skew < 0
  ) {
    fail(
      ErrorCode.INVALID_MAX_CLOCK_SKEW,
      'maxClockSkewUs must be a non-negative integer.',
      { field: 'maxClockSkewUs' },
    );
  }

  // --- spans: array of 1..500 --------------------------------------------
  const rawSpans = body.spans;
  if (!Array.isArray(rawSpans)) {
    fail(ErrorCode.INVALID_SPANS, 'spans must be an array.', {
      field: 'spans',
    });
  }
  if (rawSpans.length < MIN_SPANS || rawSpans.length > MAX_SPANS) {
    fail(
      ErrorCode.INVALID_SPANS,
      `spans must contain between ${MIN_SPANS} and ${MAX_SPANS} entries.`,
      { field: 'spans', received: rawSpans.length },
    );
  }

  // --- per-span field validation -----------------------------------------
  const spans: InputSpan[] = [];
  for (let i = 0; i < rawSpans.length; i++) {
    const item = rawSpans[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail(ErrorCode.INVALID_SPAN, `spans[${i}] must be an object.`, {
        index: i,
      });
    }
    const s = item as Record<string, unknown>;

    if (!isNonEmptyString(s.spanId)) {
      fail(ErrorCode.INVALID_SPAN, `spans[${i}].spanId must be a non-empty string.`, {
        index: i,
        field: 'spanId',
      });
    }
    if (!isNonEmptyString(s.service)) {
      fail(ErrorCode.INVALID_SPAN, `spans[${i}].service must be a non-empty string.`, {
        index: i,
        field: 'service',
      });
    }
    if (!('parentSpanId' in s) || !isNullableSpanId(s.parentSpanId)) {
      fail(
        ErrorCode.INVALID_SPAN,
        `spans[${i}].parentSpanId must be null or a non-empty string.`,
        { index: i, field: 'parentSpanId' },
      );
    }
    if (typeof s.startUs !== 'number' || !Number.isSafeInteger(s.startUs)) {
      fail(ErrorCode.INVALID_SPAN, `spans[${i}].startUs must be an integer.`, {
        index: i,
        field: 'startUs',
      });
    }
    if (typeof s.endUs !== 'number' || !Number.isSafeInteger(s.endUs)) {
      fail(ErrorCode.INVALID_SPAN, `spans[${i}].endUs must be an integer.`, {
        index: i,
        field: 'endUs',
      });
    }
    if (s.startUs >= s.endUs) {
      fail(
        ErrorCode.INVALID_SPAN,
        `spans[${i}] must start before it ends (startUs < endUs).`,
        { index: i, field: 'startUs', spanId: s.spanId },
      );
    }

    spans.push({
      spanId: s.spanId,
      service: s.service,
      parentSpanId: s.parentSpanId,
      startUs: s.startUs,
      endUs: s.endUs,
    });
  }

  // --- unique span ids ----------------------------------------------------
  const byId = new Map<string, InputSpan>();
  for (const span of spans) {
    if (byId.has(span.spanId)) {
      fail(ErrorCode.DUPLICATE_SPAN_ID, `Duplicate spanId: ${span.spanId}.`, {
        spanId: span.spanId,
      });
    }
    byId.set(span.spanId, span);
  }

  // --- parent references --------------------------------------------------
  for (const span of spans) {
    if (span.parentSpanId !== null && !byId.has(span.parentSpanId)) {
      fail(
        ErrorCode.UNKNOWN_PARENT,
        `Span ${span.spanId} references unknown parentSpanId ${span.parentSpanId}.`,
        { spanId: span.spanId, parentSpanId: span.parentSpanId },
      );
    }
  }

  // --- exactly one root ---------------------------------------------------
  const roots = spans.filter((s) => s.parentSpanId === null);
  if (roots.length === 0) {
    fail(ErrorCode.NO_ROOT, 'Trace has no root span (every span has a parent).');
  }
  if (roots.length > 1) {
    fail(ErrorCode.MULTIPLE_ROOTS, `Trace must have exactly one root, found ${roots.length}.`, {
      roots: roots.map((r) => r.spanId),
    });
  }
  const root = roots[0]!;

  // --- complete tree: every node reachable from the root ------------------
  // Each span has at most one parent, so with existing, unique parent ids the
  // only malformed shape left is a detached component (a cycle with trees
  // feeding into it); pure reachability from the root detects that.
  const children = new Map<string, InputSpan[]>();
  for (const span of spans) {
    if (span.parentSpanId !== null) {
      const list = children.get(span.parentSpanId);
      if (list === undefined) {
        children.set(span.parentSpanId, [span]);
      } else {
        list.push(span);
      }
    }
  }

  const visited = new Set<string>([root.spanId]);
  const queue: InputSpan[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const child of children.get(node.spanId) ?? []) {
      visited.add(child.spanId);
      queue.push(child);
    }
  }
  if (visited.size !== spans.length) {
    fail(ErrorCode.CYCLE_DETECTED, 'Span parent relationships form a detached cycle rather than one complete tree.');
  }

  // --- assign a dense index per service -----------------------------------
  const serviceIndex = new Map<string, number>();
  for (const span of spans) {
    if (!serviceIndex.has(span.service)) {
      serviceIndex.set(span.service, serviceIndex.size);
    }
  }

  // --- build containment difference constraints over parent edges ---------
  const edges: ParentContainmentEdge[] = [];
  for (const span of spans) {
    if (span.parentSpanId === null) continue;
    const parent = byId.get(span.parentSpanId)!;
    edges.push({
      parentService: serviceIndex.get(parent.service)!,
      childService: serviceIndex.get(span.service)!,
      parentStart: parent.startUs,
      parentEnd: parent.endUs,
      childStart: span.startUs,
      childEnd: span.endUs,
    });
  }

  const feasible = offsetsFeasible(serviceIndex.size, edges, skew);

  if (!feasible) {
    return {
      valid: false,
      reason: 'temporal_inconsistent',
      spanCount: spans.length,
      serviceCount: serviceIndex.size,
    };
  }

  return {
    valid: true,
    spanCount: spans.length,
    serviceCount: serviceIndex.size,
  };
}
