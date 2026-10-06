import { pathToFileURL } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { auditTrace } from "./audit.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error(`invalid PORT: ${process.env.PORT ?? "8080"}`);
}
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  } catch {
    // The client may already be gone (e.g. oversized body aborted the socket).
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
        reject(new Error("request body too large"));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString("utf-8");
      if (text.length === 0) {
        reject(new Error("empty request body"));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", () => {
      if (!tooLarge) reject(new Error("failed to read request body"));
    });
  });
}

export function createApp(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/traces/audit") {
      readJsonBody(req).then(
        (payload) => {
          const outcome = auditTrace(payload);
          if (outcome.ok) {
            sendJson(res, 200, outcome.result);
          } else {
            sendJson(res, 422, {
              error: {
                code: outcome.error.code,
                message: outcome.error.message,
              },
            });
          }
        },
        (error: Error) => {
          sendJson(res, 422, {
            error: { code: "invalid_request", message: error.message },
          });
        },
      );
      return;
    }

    sendJson(res, 404, { error: { code: "not_found", message: "unknown route" } });
  });
}

// Only start listening when run directly, so tests can import createApp.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`trace-audit API listening on http://${HOST}:${PORT}`);
  });
}
