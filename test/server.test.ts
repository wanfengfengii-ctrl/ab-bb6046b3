import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

describe('POST /api/traces/audit (HTTP)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 200 with counts for a valid trace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/traces/audit',
      payload: {
        maxClockSkewUs: 0,
        spans: [
          { spanId: 'r', service: 'gw', parentSpanId: null, startUs: 0, endUs: 1000 },
          { spanId: 'c', service: 'calc', parentSpanId: 'r', startUs: 100, endUs: 900 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, spanCount: 2, serviceCount: 2 });
  });

  it('returns 200 valid:false reason temporal_inconsistent for an uncorrectable trace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/traces/audit',
      payload: {
        maxClockSkewUs: 1,
        spans: [
          { spanId: 'r', service: 'gw', parentSpanId: null, startUs: 0, endUs: 100 },
          { spanId: 'c', service: 'calc', parentSpanId: 'r', startUs: 10, endUs: 110 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      valid: false,
      reason: 'temporal_inconsistent',
      spanCount: 2,
      serviceCount: 2,
    });
  });

  it('returns 422 with a stable error code for structural errors', async () => {
    const cases: Array<{ payload: unknown; code: string }> = [
      { payload: { maxClockSkewUs: -1, spans: [] }, code: 'invalid_max_clock_skew' },
      { payload: { maxClockSkewUs: 0, spans: [] }, code: 'invalid_spans' },
      {
        payload: {
          maxClockSkewUs: 0,
          spans: [{ spanId: 'a', service: 'x', parentSpanId: null, startUs: 5, endUs: 5 }],
        },
        code: 'invalid_span',
      },
      {
        payload: {
          maxClockSkewUs: 0,
          spans: [
            { spanId: 'a', service: 'x', parentSpanId: null, startUs: 0, endUs: 10 },
            { spanId: 'b', service: 'y', parentSpanId: null, startUs: 0, endUs: 10 },
          ],
        },
        code: 'multiple_roots',
      },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/traces/audit', payload: c.payload });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe(c.code);
    }
  });

  it('returns 422 invalid_body for malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/traces/audit',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('invalid_body');
  });
});
