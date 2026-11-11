"use strict";

const assert = require("assert");
const sources = require("../netlify/functions/homelink-review-sources");

const tenantId = "22222222-2222-4222-8222-222222222222";

function owner() {
  return Promise.resolve({ tenant: { id: tenantId } });
}

async function run(event, request) {
  return sources.handler(event, {
    requireOwnerOrAdmin: owner,
    supabaseRequest: request,
    homeOrigin: "https://homelink-connect-app.netlify.app"
  });
}

(async function main() {
  assert.strictEqual(sources.reviewSourceUrl("http://maps.google.com/place"), "");
  assert.strictEqual(sources.reviewSourceUrl("https://user:pass@maps.google.com/place"), "");
  assert.strictEqual(sources.reviewSourceUrl("https://maps.google.com/place?token=abc"), "");
  assert.strictEqual(sources.reviewSourceUrl("https://maps.google.com/place"), "https://maps.google.com/place");

  const denied = await sources.handler({ httpMethod: "GET", queryStringParameters: {}, headers: {} }, {
    requireOwnerOrAdmin: function () {
      const err = new Error("no_session");
      err.code = "no_session";
      err.statusCode = 401;
      throw err;
    },
    homeOrigin: "https://homelink-connect-app.netlify.app"
  });
  assert.strictEqual(denied.statusCode, 401);
  assert.strictEqual(denied.body.includes("no_session"), true);

  const forbidden = await run({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { tenant_id: tenantId }
  }, function () { throw new Error("should not read"); });
  assert.strictEqual(forbidden.statusCode, 400);

  const calls = [];
  const saved = await run({
    httpMethod: "POST",
    headers: { origin: "https://marginguardsystem.netlify.app", host: "marginguardsystem.netlify.app" },
    queryStringParameters: {},
    body: "google=" + encodeURIComponent("https://maps.google.com/place") + "&yelp=&website=" + encodeURIComponent("https://example.com/work"),
    isBase64Encoded: false
  }, function (path, opts) {
    calls.push({ path: path, opts: opts || {} });
    if (String(path).includes("select=tenant_id")) return [];
    return [];
  });
  assert.strictEqual(saved.statusCode, 200);
  assert.strictEqual(saved.body.includes("maps.google.com"), true);
  assert.strictEqual(saved.body.includes("example.com"), true);
  assert.strictEqual(saved.body.includes(tenantId), false);
  const insert = calls.find(function (call) { return call.opts.method === "POST"; });
  assert.strictEqual(insert.opts.body.google_review_url, "https://maps.google.com/place");
  assert.strictEqual(insert.opts.body.website_url, "https://example.com/work");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(insert.opts.body, "business_email"), false);

  const cross = await run({
    httpMethod: "POST",
    headers: { origin: "https://evil.example", host: "marginguardsystem.netlify.app" },
    queryStringParameters: {},
    body: "google=https%3A%2F%2Fmaps.google.com%2Fplace&yelp=&website=",
    isBase64Encoded: false
  }, function () { throw new Error("should not write"); });
  assert.strictEqual(cross.statusCode, 403);

  const bad = await run({
    httpMethod: "POST",
    headers: { origin: "https://marginguardsystem.netlify.app", host: "marginguardsystem.netlify.app" },
    queryStringParameters: { lang: "es" },
    body: "google=http%3A%2F%2Fmaps.google.com&yelp=&website=",
    isBase64Encoded: false
  }, function () { throw new Error("should not write"); });
  assert.strictEqual(bad.statusCode, 400);
  assert.strictEqual(bad.body.includes("https://"), true);

  console.log("ok review sources save only https links on this account");
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
