import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createApp } from "../src/server.js";
import type { Server } from "node:http";

describe("HTTP API", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createApp();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("reports health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("audits a correctable trace as valid", async () => {
    const res = await post("/api/traces/audit", {
      maxClockSkewUs: 100,
      spans: [
        { spanId: "p", service: "s1", startUs: 1000, endUs: 2000 },
        { spanId: "q", service: "s2", parentSpanId: "p", startUs: 1050, endUs: 2050 },
      ],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      spanCount: 2,
      serviceCount: 2,
      valid: true,
    });
  });

  it("audits an uncorrectable trace with temporal_inconsistent", async () => {
    const res = await post("/api/traces/audit", {
      maxClockSkewUs: 0,
      spans: [
        { spanId: "p", service: "s1", startUs: 0, endUs: 10 },
        { spanId: "q", service: "s2", parentSpanId: "p", startUs: 0, endUs: 20 },
      ],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      spanCount: 2,
      serviceCount: 2,
      valid: false,
      reason: "temporal_inconsistent",
    });
  });

  it("returns 422 with a stable error code for structural errors", async () => {
    const res = await post("/api/traces/audit", { maxClockSkewUs: -1, spans: [] });
    assert.equal(res.status, 422);
    const payload = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(payload.error.code, "invalid_max_clock_skew");
    assert.equal(typeof payload.error.message, "string");
  });

  it("returns 422 for malformed JSON", async () => {
    const res = await fetch(`${baseUrl}/api/traces/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 422);
    const payload = (await res.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "invalid_request");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
  });
});
