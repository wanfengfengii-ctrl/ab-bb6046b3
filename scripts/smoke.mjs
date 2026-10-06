#!/usr/bin/env node
/**
 * HTTP smoke checks for POST /api/traces/audit, run by the one-shot `verify`
 * compose service (and usable locally). It:
 *   1. waits for GET /health,
 *   2. posts a CORRECTABLE trace and asserts valid === true,
 *   3. posts an UNC0RRECTABLE trace (same shape, zero skew) and asserts
 *      valid === false / reason === 'temporal_inconsistent',
 *   4. posts a structurally invalid trace and asserts HTTP 422 + stable code.
 * Exits 0 only when every check passes.
 */

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const HEALTH_TIMEOUT_MS = 60_000;
const RETRY_INTERVAL_MS = 1_000;

const failures = [];

function report(name, ok, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.status === 200) {
        const body = await res.json();
        if (body.status === 'ok') return true;
        lastError = `unexpected body: ${JSON.stringify(body)}`;
      } else {
        lastError = `status ${res.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  throw new Error(`API did not become healthy within ${HEALTH_TIMEOUT_MS}ms (${lastError})`);
}

async function postAudit(payload) {
  const res = await fetch(`${BASE_URL}/api/traces/audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// Child [10,110] overflows parent [0,100] by 10us on the right. Both services
// may move by +/-S, so max relative correction is 2*S. At S=5 the trace is
// exactly correctable (o_gw=+5, o_calc=-5 -> both corrected to [5,105]);
// at S=0 it is a genuine inversion.
const tracePayload = (skew) => ({
  maxClockSkewUs: skew,
  spans: [
    { spanId: 'root', service: 'gw', parentSpanId: null, startUs: 0, endUs: 100 },
    { spanId: 'child', service: 'calc', parentSpanId: 'root', startUs: 10, endUs: 110 },
  ],
});

async function main() {
  console.log(`Smoke testing API at ${BASE_URL}`);
  await waitForHealth();
  console.log('[PASS] GET /health returned ok');

  // --- correctable ---------------------------------------------------------
  const good = await postAudit(tracePayload(5));
  report(
    'correctable trace -> 200 valid=true with counts',
    good.status === 200 &&
      good.body?.valid === true &&
      good.body?.spanCount === 2 &&
      good.body?.serviceCount === 2 &&
      good.body?.reason === undefined,
    `status=${good.status} body=${JSON.stringify(good.body)}`,
  );

  // --- uncorrectable -------------------------------------------------------
  const bad = await postAudit(tracePayload(0));
  report(
    'uncorrectable trace -> 200 valid=false reason=temporal_inconsistent with counts',
    bad.status === 200 &&
      bad.body?.valid === false &&
      bad.body?.reason === 'temporal_inconsistent' &&
      bad.body?.spanCount === 2 &&
      bad.body?.serviceCount === 2,
    `status=${bad.status} body=${JSON.stringify(bad.body)}`,
  );

  // --- structural error ----------------------------------------------------
  const invalid = await postAudit({
    maxClockSkewUs: 0,
    spans: [
      { spanId: 'a', service: 'gw', parentSpanId: null, startUs: 0, endUs: 10 },
      { spanId: 'b', service: 'db', parentSpanId: null, startUs: 0, endUs: 10 },
    ],
  });
  report(
    'structural error -> 422 with stable error code multiple_roots',
    invalid.status === 422 && invalid.body?.error === 'multiple_roots',
    `status=${invalid.status} body=${JSON.stringify(invalid.body)}`,
  );

  if (failures.length > 0) {
    console.error(`\n${failures.length} smoke check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
