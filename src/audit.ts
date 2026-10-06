/**
 * Trace causality audit.
 *
 * The recorded timestamps of every service may deviate from real time by one
 * constant integer clock offset o(s), with |o(s)| <= maxClockSkewUs. The
 * corrected time of an event x is `recorded(x) + o(service(x))`.
 *
 * For every parent p -> child c the corrected child must be fully contained in
 * the corrected parent:
 *
 *   start_c + o(c) >= start_p + o(p)   <=>   o(p) - o(c) <= start_c - start_p
 *   end_c   + o(c) <= end_p   + o(p)   <=>   o(c) - o(p) <= end_p   - end_c
 *
 * Together with |o(s)| <= K these are difference constraints of the form
 * x_v - x_u <= w. They are feasible exactly when the constraint graph has no
 * negative-weight cycle, which is checked with Bellman-Ford using BigInt so
 * integer arithmetic never loses precision.
 */

export const MAX_SPANS = 500;

export interface NormalizedSpan {
  spanId: string;
  service: string;
  parentSpanId: string | null;
  start: bigint;
  end: bigint;
}

export interface AuditSuccess {
  spanCount: number;
  serviceCount: number;
  valid: boolean;
  reason?: "temporal_inconsistent";
}

export type AuditOutcome =
  | { ok: true; result: AuditSuccess }
  | { ok: false; error: { code: string; message: string } };

function fail(code: string, message: string): AuditOutcome {
  return { ok: false, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the request payload and, when it describes a structurally complete
 * single-root span tree, decide whether one global clock offset per service can
 * make every child span fall inside its parent span.
 */
export function auditTrace(input: unknown): AuditOutcome {
  if (!isObject(input)) {
    return fail("invalid_request", "request body must be a JSON object");
  }

  const skewRaw = input.maxClockSkewUs;
  if (typeof skewRaw !== "number" || !Number.isSafeInteger(skewRaw) || skewRaw < 0) {
    return fail(
      "invalid_max_clock_skew",
      "maxClockSkewUs must be a non-negative integer",
    );
  }
  const skew = BigInt(skewRaw);

  const rawSpans = input.spans;
  if (!Array.isArray(rawSpans)) {
    return fail("invalid_spans", "spans must be an array of 1..500 items");
  }
  if (rawSpans.length < 1 || rawSpans.length > MAX_SPANS) {
    return fail(
      "invalid_spans",
      `spans must contain between 1 and ${MAX_SPANS} items`,
    );
  }

  const spans: NormalizedSpan[] = [];
  for (let i = 0; i < rawSpans.length; i++) {
    const raw = rawSpans[i];
    const where = `spans[${i}]`;
    if (!isObject(raw)) {
      return fail("invalid_span", `${where} must be an object`);
    }
    if (typeof raw.spanId !== "string" || raw.spanId.length === 0) {
      return fail("invalid_span_id", `${where}.spanId must be a non-empty string`);
    }
    if (typeof raw.service !== "string" || raw.service.length === 0) {
      return fail("invalid_service", `${where}.service must be a non-empty string`);
    }
    let parentSpanId: string | null;
    if (raw.parentSpanId === null || raw.parentSpanId === undefined) {
      parentSpanId = null;
    } else if (typeof raw.parentSpanId === "string" && raw.parentSpanId.length > 0) {
      parentSpanId = raw.parentSpanId;
    } else {
      return fail(
        "invalid_parent_span_id",
        `${where}.parentSpanId must be null or a non-empty string`,
      );
    }
    if (typeof raw.startUs !== "number" || !Number.isSafeInteger(raw.startUs)) {
      return fail("invalid_timestamp", `${where}.startUs must be an integer`);
    }
    if (typeof raw.endUs !== "number" || !Number.isSafeInteger(raw.endUs)) {
      return fail("invalid_timestamp", `${where}.endUs must be an integer`);
    }
    const start = BigInt(raw.startUs);
    const end = BigInt(raw.endUs);
    if (start >= end) {
      return fail(
        "invalid_span_interval",
        `${where}.startUs must be strictly earlier than endUs`,
      );
    }
    spans.push({
      spanId: raw.spanId,
      service: raw.service,
      parentSpanId,
      start,
      end,
    });
  }

  // Unique span ids.
  const byId = new Map<string, NormalizedSpan>();
  for (const span of spans) {
    if (byId.has(span.spanId)) {
      return fail("duplicate_span_id", `duplicate spanId: ${span.spanId}`);
    }
    byId.set(span.spanId, span);
  }

  // Every parent reference must resolve.
  for (const span of spans) {
    if (span.parentSpanId !== null && !byId.has(span.parentSpanId)) {
      return fail(
        "parent_span_not_found",
        `span ${span.spanId} references unknown parent ${span.parentSpanId}`,
      );
    }
  }

  // Exactly one root.
  const roots = spans.filter((s) => s.parentSpanId === null);
  if (roots.length === 0) {
    return fail("no_root_span", "span tree must contain exactly one root span");
  }
  if (roots.length > 1) {
    return fail(
      "multiple_root_spans",
      `span tree must contain exactly one root, found ${roots.length}`,
    );
  }

  // The graph must be one complete tree: traversal from the root must reach
  // every span. This also rejects cycles (including a span parenting itself).
  const children = new Map<string, NormalizedSpan[]>();
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
  const seen = new Set<string>([roots[0]!.spanId]);
  const queue: NormalizedSpan[] = [roots[0]!];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current.spanId) ?? []) {
      if (seen.has(child.spanId)) {
        return fail("span_graph_cycle", "spans must form an acyclic tree");
      }
      seen.add(child.spanId);
      queue.push(child);
    }
  }
  if (seen.size !== spans.length) {
    return fail("span_graph_cycle", "spans must form one complete tree rooted at a single span");
  }

  const services = new Set(spans.map((s) => s.service));
  const valid = hasFeasibleOffsets(spans, byId, services.size, skew);

  const result: AuditSuccess = {
    spanCount: spans.length,
    serviceCount: services.size,
    valid,
  };
  if (!valid) {
    result.reason = "temporal_inconsistent";
  }
  return { ok: true, result };
}

/**
 * Difference-constraint feasibility via Bellman-Ford negative-cycle detection.
 *
 * A virtual node z with edges z -> s of weight K and s -> z of weight K encodes
 * -K <= o(s) <= K (equivalently o(s) <= K and -o(s) <= K). Starting every
 * distance at 0 is equivalent to seeding the relaxation from z.
 */
function hasFeasibleOffsets(
  spans: NormalizedSpan[],
  byId: Map<string, NormalizedSpan>,
  serviceCount: number,
  skew: bigint,
): boolean {
  const serviceIndex = new Map<string, number>();
  for (const span of spans) {
    if (!serviceIndex.has(span.service)) {
      serviceIndex.set(span.service, serviceIndex.size);
    }
  }

  const z = serviceCount;
  const nodeCount = serviceCount + 1;

  // Each edge [u, v, w] means: dist[v] <= dist[u] + w, i.e. x_v - x_u <= w.
  const edges: Array<readonly [number, number, bigint]> = [];
  for (let i = 0; i < serviceCount; i++) {
    edges.push([z, i, skew]); // o(i) <= K
    edges.push([i, z, skew]); // -o(i) <= K
  }
  for (const child of spans) {
    if (child.parentSpanId === null) continue;
    const parent = byId.get(child.parentSpanId);
    if (parent === undefined) continue;
    const p = serviceIndex.get(parent.service)!;
    const c = serviceIndex.get(child.service)!;
    // start_c + o(c) >= start_p + o(p)
    //   => o(p) - o(c) <= start_c - start_p, edge c -> p
    edges.push([c, p, child.start - parent.start]);
    // end_c + o(c) <= end_p + o(p)
    //   => o(c) - o(p) <= end_p - end_c, edge p -> c
    edges.push([p, c, parent.end - child.end]);
  }

  const dist: bigint[] = new Array(nodeCount).fill(0n);
  for (let iteration = 0; iteration < nodeCount; iteration++) {
    let changed = false;
    for (const [u, v, w] of edges) {
      const candidate = dist[u]! + w;
      if (dist[v]! > candidate) {
        dist[v] = candidate;
        changed = true;
      }
    }
    if (!changed) {
      return true;
    }
  }
  // An (N)th relaxation still improving a distance proves a negative cycle.
  for (const [u, v, w] of edges) {
    if (dist[v]! > dist[u]! + w) {
      return false;
    }
  }
  return true;
}
