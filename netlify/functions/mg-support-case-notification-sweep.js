/**
 * MG-SUPPORT-003E.2D3 / 2D-F1 — scheduled pending Support notification recovery.
 *
 * Netlify Functions v2 in-source config. Cron must be a string literal so
 * zip-it-and-ship-it static analysis can register the schedule.
 * No path / excludedPath. Production does not accept public URL invocation.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createHandler } = require("./_lib/mg-support/notification-sweep");

export const config = {
  schedule: "*/5 * * * *",
};

const v1Handler = createHandler();

function headersToObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export default async function scheduledSweep(request) {
  const method = String(request && request.method ? request.method : "POST").toUpperCase();
  let body = "";
  try {
    body = request && typeof request.text === "function" ? await request.text() : "";
  } catch (_err) {
    body = "";
  }
  const result = await v1Handler({
    httpMethod: method,
    headers: headersToObject(request && request.headers),
    body,
  });
  return new Response(result.body, {
    status: result.statusCode,
    headers: result.headers,
  });
}
