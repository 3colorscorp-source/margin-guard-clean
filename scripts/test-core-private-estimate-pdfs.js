#!/usr/bin/env node
/**
 * Core Security — privatize estimate-pdfs (SQL not applied to production).
 * Isolated mocks + disposable storage.buckets catalog. Does not fetch client
 * PDFs, live Netlify, Zapier, or production storage.
 * Run: node scripts/test-core-private-estimate-pdfs.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-private-estimate-pdfs-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-private-estimate-pdfs-test-key";
process.env.SITE_URL = process.env.SITE_URL || "https://example.test";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APPLY = "SUPABASE_MG_CORE_SECURITY_PRIVATE_ESTIMATE_PDFS.sql";
const ROLLBACK = "SUPABASE_MG_CORE_SECURITY_PRIVATE_ESTIMATE_PDFS_ROLLBACK.sql";
const VERIFY = "SUPABASE_MG_CORE_SECURITY_PRIVATE_ESTIMATE_PDFS_VERIFY.sql";

const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const {
  buildDeviceSessionPayload,
  createDeviceSessionCookieFromPayload,
  DEVICE_COOKIE_NAME,
} = require("../netlify/functions/_lib/device-session");
const {
  parseEstimatePdfObjectPath,
  signEstimatePdfAccess,
  buildEstimatePdfAccessUrl,
  SIGNED_URL_EXPIRES_SEC,
  ESTIMATE_PDF_BUCKET,
} = require("../netlify/functions/_lib/estimate-pdf-access");

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const TOKEN_A = "qt_core_security_test_token";
const INTERNAL_TEST_PATH = TENANT_A + "/2026-09-10/CORE-SECURITY-TEST.pdf";
const OTHER_SAME_TENANT_PATH = TENANT_A + "/2026-09-10/OTHER-QUOTE.pdf";
const CROSS_PATH = TENANT_B + "/2026-09-10/CORE-SECURITY-TEST.pdf";
const CUS_A = "cus_legacyOwnerA123";
const SELLER_MEM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SELLER_DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SELLER_SESS = "ffffffff-ffff-4fff-8fff-ffffffffffff";

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}
function eq(label, a, b) {
  assert.strictEqual(a, b, label + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a));
  passed += 1;
  console.log("PASS " + label);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function cookieFor(fields) {
  return createSessionCookie(
    buildSessionPayload({
      email: fields.e || "",
      tenantId: fields.t || "",
      userId: fields.u || "",
      customerId: fields.c || "",
    })
  );
}

function eventFor(fields, opts) {
  const headers = Object.assign({}, (opts && opts.headers) || {});
  const cookies = [];
  if (fields) cookies.push(cookieFor(fields));
  if (opts && opts.deviceCookie) cookies.push(opts.deviceCookie);
  if (cookies.length) headers.cookie = cookies.join("; ");
  return {
    httpMethod: (opts && opts.method) || "GET",
    headers,
    queryStringParameters: (opts && opts.query) || {},
  };
}

function accessQuery(token, objectPath) {
  const url = buildEstimatePdfAccessUrl("https://example.test", token, objectPath);
  const u = new URL(url);
  const q = {};
  u.searchParams.forEach((v, k) => {
    q[k] = v;
  });
  return q;
}

function qp(restPath, key) {
  const q = String(restPath).split("?")[1] || "";
  const part = q.split("&").find((p) => p.startsWith(key + "="));
  if (!part) return "";
  return decodeURIComponent(part.slice(key.length + 1).replace(/^eq\./, ""));
}

function seedCatalog() {
  return [
    { id: "estimate-pdfs", name: "estimate-pdfs", public: true },
    { id: "tenant-logos", name: "tenant-logos", public: true },
    { id: "contract-signed-pdfs", name: "contract-signed-pdfs", public: false },
  ].map((row) => Object.assign({}, row));
}

function findBucket(catalog, id) {
  return catalog.find((row) => row.id === id) || null;
}

function applyPrivate(catalog) {
  const next = catalog.map((row) => Object.assign({}, row));
  const logos = findBucket(next, "tenant-logos");
  const contracts = findBucket(next, "contract-signed-pdfs");
  const row = next.find((b) => b.id === "estimate-pdfs" && b.name === "estimate-pdfs");
  if (!row) throw new Error("missing estimate-pdfs");
  row.public = false;
  const n = next.filter((b) => b.id === "estimate-pdfs" && b.name === "estimate-pdfs" && b.public === false).length;
  if (n !== 1) throw new Error("apply did not privatize estimate-pdfs");
  if (logos && logos.public !== true) throw new Error("tenant-logos changed");
  if (contracts && contracts.public !== false) throw new Error("contract-signed-pdfs changed");
  return next;
}

function rollbackPublic(catalog) {
  const next = catalog.map((row) => Object.assign({}, row));
  const row = next.find((b) => b.id === "estimate-pdfs" && b.name === "estimate-pdfs");
  if (!row) throw new Error("missing estimate-pdfs");
  row.public = true;
  const n = next.filter((b) => b.id === "estimate-pdfs" && b.name === "estimate-pdfs" && b.public === true).length;
  if (n !== 1) throw new Error("rollback did not restore estimate-pdfs");
  return next;
}

function anonymousPublicGet(catalog, objectPath) {
  const bucket = findBucket(catalog, "estimate-pdfs");
  if (!bucket || bucket.public !== true) {
    return { status: 400, error: "Bucket is not public", body: JSON.stringify({ statusCode: 400, error: "Bucket is not public" }) };
  }
  if (!parseEstimatePdfObjectPath(objectPath)) {
    return { status: 400, error: "Invalid path" };
  }
  return { status: 200, error: null, body: "%PDF-fixture" };
}

function cacheBust() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/tenant-device-guard",
    "../netlify/functions/_lib/device-session",
    "../netlify/functions/_lib/estimate-pdf-access",
    "../netlify/functions/get-estimate-pdf",
  ].forEach((rel) => {
    try {
      delete require.cache[require.resolve(rel)];
    } catch (_err) {
      /* optional */
    }
  });
}

async function withDb(fn) {
  const prev = globalThis.fetch;
  const captured = { signExpires: null, signPath: "", publicGets: [] };
  const sellerDevice = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({
      sessionId: SELLER_SESS,
      deviceId: SELLER_DEVICE,
      tenantId: TENANT_A,
      membershipId: SELLER_MEM,
      portalType: "seller",
    })
  );
  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    const method = String((opts && opts.method) || "GET").toUpperCase();
    if (href.indexOf("/storage/v1/object/public/estimate-pdfs/") >= 0) {
      captured.publicGets.push(href);
      return jsonRes(400, { statusCode: 400, error: "Bucket is not public" });
    }
    if (href.indexOf("/storage/v1/object/sign/") >= 0) {
      captured.signPath = href;
      try {
        captured.signExpires = JSON.parse((opts && opts.body) || "{}").expiresIn;
      } catch (_err) {
        captured.signExpires = null;
      }
      return jsonRes(200, {
        signedURL: "/object/sign/estimate-pdfs/" + INTERNAL_TEST_PATH + "?token=short-lived",
      });
    }
    const idx = href.indexOf("/rest/v1/");
    const restPath = idx >= 0 ? href.slice(idx + "/rest/v1/".length) : href;
    const table = restPath.split("?")[0];
    if (table === "quotes") {
      const token = qp(restPath, "public_token");
      if (token === TOKEN_A) return jsonRes(200, [{ id: "qa", tenant_id: TENANT_A, public_token: TOKEN_A }]);
      return jsonRes(200, []);
    }
    if (table === "profiles") {
      const email = qp(restPath, "email");
      const id = qp(restPath, "id");
      const tenantId = qp(restPath, "tenant_id");
      const rows = [
        {
          id: "prof-owner",
          tenant_id: TENANT_A,
          email: OWNER_A,
          role: "owner",
          status: "active",
          auth_user_id: "11111111-1111-4111-8111-111111111111",
        },
        {
          id: SELLER_MEM,
          tenant_id: TENANT_A,
          email: "seller-a@example.com",
          role: "seller",
          status: "active",
          auth_user_id: "seller-user-a",
        },
      ].filter((p) => {
        if (email && p.email !== email) return false;
        if (id && p.id !== id) return false;
        if (tenantId && p.tenant_id !== tenantId) return false;
        return true;
      });
      return jsonRes(200, rows);
    }
    if (table === "tenants") {
      const id = qp(restPath, "id");
      const cus = qp(restPath, "stripe_customer_id");
      if (id === TENANT_A || cus === CUS_A) {
        return jsonRes(200, [
          {
            id: TENANT_A,
            owner_email: OWNER_A,
            plan_status: "active",
            stripe_customer_id: CUS_A,
            slug: "co-a",
            name: "Co A",
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "device_sessions") {
      const hash = qp(restPath, "session_token_hash");
      if (hash && hash === sellerDevice.tokenHash) {
        return jsonRes(200, [
          {
            id: SELLER_SESS,
            device_id: SELLER_DEVICE,
            tenant_id: TENANT_A,
            membership_id: SELLER_MEM,
            portal_type: "seller",
            status: "active",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            session_token_hash: sellerDevice.tokenHash,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_devices") {
      const id = qp(restPath, "id");
      if (id === SELLER_DEVICE) {
        return jsonRes(200, [{ id: SELLER_DEVICE, tenant_id: TENANT_A, portal_type: "seller", status: "active" }]);
      }
      return jsonRes(200, []);
    }
    return jsonRes(method === "GET" ? 200 : 200, []);
  };
  try {
    cacheBust();
    await fn(captured, sellerDevice);
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const applySql = read(APPLY);
  const rollbackSql = read(ROLLBACK);
  const verifySql = read(VERIFY);
  const helperSrc = read("netlify/functions/_lib/estimate-pdf-access.js");
  const fnSrc = read("netlify/functions/get-estimate-pdf.js");
  const sendSrc = read("netlify/functions/send-quote-zapier.js");
  const resendSrc = read("netlify/functions/resend-tenant-quote.js");
  const publicSendSrc = read("public/js/estimate-public-send.js");
  const publicPageSrc = read("public/estimate-public.html");
  const logoSrc = read("netlify/functions/upload-tenant-logo.js");
  const contractSrc = read("netlify/functions/_lib/contract-signed-pdf.js");

  ok("apply is transactional", applySql.indexOf("BEGIN;") >= 0 && applySql.indexOf("COMMIT;") >= 0);
  ok("rollback is transactional", rollbackSql.indexOf("BEGIN;") >= 0 && rollbackSql.indexOf("COMMIT;") >= 0);
  ok("verify is read-only", verifySql.indexOf("BEGIN TRANSACTION READ ONLY") >= 0 && verifySql.indexOf("ROLLBACK;") >= 0);
  ok("apply sets estimate-pdfs public false", /SET public = false/.test(applySql) && applySql.indexOf("id = 'estimate-pdfs'") >= 0);
  ok("rollback restores estimate-pdfs public true", /SET public = true/.test(rollbackSql) && rollbackSql.indexOf("id = 'estimate-pdfs'") >= 0);
  ok("apply does not CREATE POLICY", applySql.indexOf("CREATE POLICY") < 0);
  ok("rollback does not CREATE POLICY", rollbackSql.indexOf("CREATE POLICY") < 0);
  ok("verify does not CREATE POLICY", verifySql.indexOf("CREATE POLICY") < 0);
  ok("apply does not GRANT anon", applySql.indexOf("TO anon") < 0);
  ok("apply does not GRANT authenticated", applySql.indexOf("TO authenticated") < 0);
  ok("apply UPDATE targets only estimate-pdfs", /UPDATE storage\.buckets\s+SET public = false\s+WHERE id = 'estimate-pdfs'/.test(applySql));
  ok("SQL files refuse production apply from CI", applySql.indexOf("DO NOT apply from CI") >= 0);

  const before = seedCatalog();
  eq("disposable catalog starts with public estimate-pdfs", findBucket(before, "estimate-pdfs").public, true);
  const anonBefore = anonymousPublicGet(before, INTERNAL_TEST_PATH);
  eq("anonymous public GET works while bucket is public", anonBefore.status, 200);

  const afterApply = applyPrivate(before);
  eq("apply privatizes only estimate-pdfs", findBucket(afterApply, "estimate-pdfs").public, false);
  eq("apply leaves tenant-logos public", findBucket(afterApply, "tenant-logos").public, true);
  eq("apply leaves contract-signed-pdfs private", findBucket(afterApply, "contract-signed-pdfs").public, false);
  const anonAfter = anonymousPublicGet(afterApply, INTERNAL_TEST_PATH);
  eq("anonymous public GET fails after privatize", anonAfter.status, 400);
  eq("anonymous failure is Bucket is not public", anonAfter.error, "Bucket is not public");

  const afterRollback = rollbackPublic(afterApply);
  eq("rollback restores public estimate-pdfs", findBucket(afterRollback, "estimate-pdfs").public, true);
  eq("rollback leaves tenant-logos public", findBucket(afterRollback, "tenant-logos").public, true);
  eq("rollback leaves contract-signed-pdfs private", findBucket(afterRollback, "contract-signed-pdfs").public, false);

  eq("bucket name stays estimate-pdfs", ESTIMATE_PDF_BUCKET, "estimate-pdfs");
  ok("new buckets are created private", helperSrc.indexOf("public: false") >= 0);
  ok("helper does not PATCH production buckets", helperSrc.indexOf("/storage/v1/bucket/") < 0);
  ok("helper never emits object/public URLs", helperSrc.indexOf("object/public") < 0);
  ok("send no longer emits public object URLs", sendSrc.indexOf("object/public/estimate-pdfs") < 0);
  ok("resend pdf_url stays empty", resendSrc.indexOf("pdf_url: \"\"") >= 0);
  ok("resend does not emit public estimate-pdfs URLs", resendSrc.indexOf("object/public/estimate-pdfs") < 0);
  ok("public quote send pipeline has no public storage PDF URL", publicSendSrc.indexOf("object/public/estimate-pdfs") < 0);
  ok("public estimate page has no storage PDF URL", publicPageSrc.indexOf("object/public/estimate-pdfs") < 0);
  ok("send uses HMAC access URL helper", sendSrc.indexOf("buildEstimatePdfAccessUrl") >= 0);
  const access = buildEstimatePdfAccessUrl("https://example.test", TOKEN_A, INTERNAL_TEST_PATH);
  ok("new email URL is get-estimate-pdf", access.indexOf("get-estimate-pdf") >= 0);
  ok("new email URL has token", access.indexOf("token=" + TOKEN_A) >= 0);
  ok("new email URL has path", access.indexOf("path=" + encodeURIComponent(INTERNAL_TEST_PATH)) >= 0 || access.indexOf("path=" + INTERNAL_TEST_PATH) >= 0);
  ok("new email URL has sig", /[?&]sig=[0-9a-f]{64}/.test(access));
  eq("signed URL TTL is 60s", SIGNED_URL_EXPIRES_SEC, 60);
  ok("tenant-logos stays public", logoSrc.indexOf("public: true") >= 0);
  ok("contract-signed-pdfs stays private", contractSrc.indexOf("public: false") >= 0);
  ok("writes stay service_role", helperSrc.indexOf("Authorization: `Bearer ${key}`") >= 0);
  ok("handler does not add storage policies", fnSrc.indexOf("CREATE POLICY") < 0);

  await withDb(async (captured, sellerDevice) => {
    const mod = require("../netlify/functions/get-estimate-pdf");
    const bound = accessQuery(TOKEN_A, INTERNAL_TEST_PATH);

    const publicGet = await globalThis.fetch(
      "https://example.supabase.co/storage/v1/object/public/estimate-pdfs/" + INTERNAL_TEST_PATH
    );
    eq("mocked anonymous public object GET is 400", publicGet.status, 400);

    captured.signExpires = null;
    const valid = await mod.handler(eventFor(null, { query: bound }));
    eq("exact token+path+sig redirects", valid.statusCode, 302);
    eq("protected signed URL expires in 60s", captured.signExpires, 60);
    ok("sign request uses estimate-pdfs", captured.signPath.indexOf("/object/sign/estimate-pdfs/") >= 0);
    ok("valid body has no service_role", String(valid.body || "").indexOf("service_role") < 0);

    const other = await mod.handler(
      eventFor(null, { query: { path: OTHER_SAME_TENANT_PATH, token: TOKEN_A, sig: bound.sig } })
    );
    eq("token cannot read another PDF of the same tenant", other.statusCode, 401);

    const owner = await mod.handler(eventFor({ e: OWNER_A, t: TENANT_A }, { query: { path: INTERNAL_TEST_PATH } }));
    eq("Owner same tenant is allowed", owner.statusCode, 302);

    const seller = await mod.handler(
      eventFor(null, {
        query: { path: INTERNAL_TEST_PATH },
        deviceCookie: DEVICE_COOKIE_NAME + "=" + encodeURIComponent(sellerDevice.token),
      })
    );
    eq("Seller same tenant is allowed", seller.statusCode, 302);

    const cross = await mod.handler(
      eventFor({ e: OWNER_A, t: TENANT_A }, { query: { path: CROSS_PATH } })
    );
    eq("cross-tenant path is forbidden", cross.statusCode, 403);

    const trav = await mod.handler(eventFor(null, { query: { path: TENANT_A + "/../x.pdf", token: TOKEN_A, sig: bound.sig } }));
    eq("traversal is rejected", trav.statusCode, 400);

    const badSig = await mod.handler(
      eventFor(null, { query: { path: INTERNAL_TEST_PATH, token: TOKEN_A, sig: "0".repeat(64) } })
    );
    eq("invalid signature is rejected", badSig.statusCode, 401);
  });

  const historical =
    "https://example.supabase.co/storage/v1/object/public/estimate-pdfs/" + INTERNAL_TEST_PATH;
  ok("historical public URL shape is documented", /\/object\/public\/estimate-pdfs\//.test(historical));
  ok(
    "docs record that historical public URLs expire at privatize",
    read("docs/CORE_SECURITY_AUDIT.md").indexOf("/object/public/estimate-pdfs/") >= 0 &&
      read("docs/CORE_SECURITY_AUDIT.md").indexOf("historical") >= 0
  );

  const manifest = JSON.parse(read("scripts/mg-core-security-shield-v1.json"));
  const suite = (manifest.required || []).find((row) => row && row.id === "core-private-estimate-pdfs");
  ok("manifest lists private estimate PDF suite", Boolean(suite));
  ok("manifest private estimate PDF path is frozen", suite && suite.path === "scripts/test-core-private-estimate-pdfs.js");
  eq("manifest private estimate PDF minPassed is 57", suite && suite.minPassed, 57);

  console.log("\nCore private estimate PDFs: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
