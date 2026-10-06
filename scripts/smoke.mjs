#!/usr/bin/env node
/**
 * HTTP smoke test for POST /api/traces/audit.
 *
 * If API_URL is set (e.g. http://api:8080 inside docker compose) it is used
 * directly; otherwise the production build is started locally on an ephemeral
 * port, probed through /health, and shut down afterwards.
 *
 * Exits 0 when every expectation holds, 1 otherwise.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const API_URL = process.env.API_URL ?? null;

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) fail(message);
  else console.log(`  ok - ${message}`);
}

async function waitForHealth(baseUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
      lastError = new Error(`status ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`API did not become healthy: ${lastError?.message ?? lastError}`);
}

function startLocalServer() {
  const port = 8100 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[api] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[api] ${chunk}`));
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

async function audit(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/api/traces/audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function main() {
  let child = null;
  let baseUrl;
  if (API_URL) {
    baseUrl = API_URL.replace(/\/$/, "");
  } else {
    ({ child, baseUrl } = startLocalServer());
  }

  try {
    await waitForHealth(baseUrl);
    console.log("smoke: API healthy");

    // --- correctable trace ------------------------------------------------
    // Parent [1000,2000] on s1; child clock 50us fast so recorded [1050,2050].
    // A relative offset of 50 split over two clocks needs K >= 25.
    const correctablePayload = {
      maxClockSkewUs: 100,
      spans: [
        { spanId: "p", service: "s1", startUs: 1000, endUs: 2000 },
        { spanId: "q", service: "s2", parentSpanId: "p", startUs: 1050, endUs: 2050 },
      ],
    };
    let r = await audit(baseUrl, correctablePayload);
    assert(r.status === 200, `correctable trace returns 200 (got ${r.status})`);
    assert(r.json?.valid === true, "correctable trace judged valid=true");
    assert(r.json?.spanCount === 2, "correctable trace reports spanCount=2");
    assert(r.json?.serviceCount === 2, "correctable trace reports serviceCount=2");
    assert(
      r.json?.reason === undefined,
      "valid trace carries no reason",
    );

    // The same unordered spans (reversed in the array) must give the same answer.
    const shuffled = {
      maxClockSkewUs: 100,
      spans: [...correctablePayload.spans].reverse(),
    };
    r = await audit(baseUrl, shuffled);
    assert(r.json?.valid === true, "span order does not affect the verdict");

    // --- uncorrectable trace ----------------------------------------------
    r = await audit(baseUrl, {
      maxClockSkewUs: 0,
      spans: [
        { spanId: "p", service: "s1", startUs: 0, endUs: 10 },
        { spanId: "q", service: "s2", parentSpanId: "p", startUs: 0, endUs: 20 },
      ],
    });
    assert(r.status === 200, `uncorrectable trace returns 200 (got ${r.status})`);
    assert(r.json?.valid === false, "child longer than parent is valid=false");
    assert(
      r.json?.reason === "temporal_inconsistent",
      "invalid trace carries reason=temporal_inconsistent",
    );
    assert(r.json?.spanCount === 2 && r.json?.serviceCount === 2, "counts still reported");

    // Skew budget too small must also be uncorrectable.
    r = await audit(baseUrl, { ...correctablePayload, maxClockSkewUs: 10 });
    assert(r.json?.valid === false, "skew budget 10 cannot cover required shift of 50");
    assert(r.json?.reason === "temporal_inconsistent", "short budget -> temporal_inconsistent");

    // --- structural errors -------------------------------------------------
    r = await audit(baseUrl, { maxClockSkewUs: -3, spans: [] });
    assert(r.status === 422, `structural error returns 422 (got ${r.status})`);
    assert(
      r.json?.error?.code === "invalid_max_clock_skew",
      "stable error code invalid_max_clock_skew",
    );

    r = await audit(baseUrl, {
      maxClockSkewUs: 0,
      spans: [{ spanId: "a", service: "s1", startUs: 5, endUs: 5 }],
    });
    assert(r.status === 422 && r.json?.error?.code === "invalid_span_interval",
      "zero-length span rejected with invalid_span_interval");

    r = await audit(baseUrl, {
      maxClockSkewUs: 0,
      spans: [
        { spanId: "a", service: "s1", startUs: 0, endUs: 10 },
        { spanId: "b", service: "s2", startUs: 0, endUs: 10 },
      ],
    });
    assert(r.status === 422 && r.json?.error?.code === "multiple_root_spans",
      "two roots rejected with multiple_root_spans");
  } catch (error) {
    fail(error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    if (child) child.kill("SIGTERM");
  }

  if (process.exitCode === 1) {
    console.error("SMOKE RESULT: failure");
  } else {
    console.log("SMOKE RESULT: success");
  }
}

main();
