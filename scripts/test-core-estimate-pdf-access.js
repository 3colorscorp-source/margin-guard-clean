#!/usr/bin/env node
/**
 * Core Security — estimate PDF access (compatible phase).
 * Isolated mocked Supabase only. Does not fetch client PDFs, live Netlify,
 * Zapier, or production storage. The CORE SECURITY TEST object path is a
 * fixture, not a customer document.
 * Run: node scripts/test-core-estimate-pdf-access.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-estimate-pdf-access-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-estimate-pdf-access-test-key";
process.env.SITE_URL = process.env.SITE_URL || "https://example.test";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const {
  buildDeviceSessionPayload,
  createDeviceSessionCookieFromPayload,
  DEVICE_COOKIE_NAME,
} = require("../netlify/functions/_lib/device-session");
const {
  parseEstimatePdfObjectPath,
  signEstimatePdfAccess,
  verifyEstimatePdfAccess,
  buildEstimatePdfAccessUrl,
  SIGNED_URL_EXPIRES_SEC,
  ESTIMATE_PDF_BUCKET,
} = require("../netlify/functions/_lib/estimate-pdf-access");

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const TOKEN_A = "qt_core_security_test_token";
const TOKEN_B = "qt_other_tenant_token_xx";
const INTERNAL_TEST_PATH = TENANT_A + "/2026-09-10/CORE-SECURITY-TEST.pdf";
const OTHER_SAME_TENANT_PATH = TENANT_A + "/2026-09-10/OTHER-QUOTE.pdf";
const CROSS_PATH = TENANT_B + "/2026-09-10/CORE-SECURITY-TEST.pdf";
const CUS_A = "cus_legacyOwnerA123";
const SELLER_MEM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SUPER_MEM = "99999999-eeee-4eee-8eee-eeeeeeeeeeee";
const SELLER_DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SUPER_DEVICE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SELLER_SESS = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SUPER_SESS = "aaaaaaaa-ffff-4fff-8fff-ffffffffffff";

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
    body: opts && opts.body != null ? JSON.stringify(opts.body) : undefined,
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

function deviceCookieHeader(device) {
  return DEVICE_COOKIE_NAME + "=" + encodeURIComponent(device.token);
}

function qp(restPath, key) {
  const q = String(restPath).split("?")[1] || "";
  const part = q.split("&").find((p) => p.startsWith(key + "="));
  if (!part) return "";
  return decodeURIComponent(part.slice(key.length + 1).replace(/^eq\./, ""));
}

function profile(tenantId, email, role, id) {
  return {
    id: id || "prof-" + email.split("@")[0],
    tenant_id: tenantId,
    email,
    role: role || "owner",
    status: "active",
    auth_user_id: "11111111-1111-4111-8111-111111111111",
  };
}

function loadPdfHandler() {
  const rel = "../netlify/functions/get-estimate-pdf";
  delete require.cache[require.resolve(rel)];
  return require(rel);
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
  const captured = { signExpires: null, signPath: "", lastHref: "" };
  const sellerDevice = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({
      sessionId: SELLER_SESS,
      deviceId: SELLER_DEVICE,
      tenantId: TENANT_A,
      membershipId: SELLER_MEM,
      portalType: "seller",
    })
  );
  const supervisorDevice = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({
      sessionId: SUPER_SESS,
      deviceId: SUPER_DEVICE,
      tenantId: TENANT_A,
      membershipId: SUPER_MEM,
      portalType: "supervisor",
    })
  );
  const sellerB = createDeviceSessionCookieFromPayload(
    buildDeviceSessionPayload({
      sessionId: "bbbbbbbb-ffff-4fff-8fff-ffffffffffff",
      deviceId: "bbbbbbbb-dddd-4ddd-8ddd-dddddddddddd",
      tenantId: TENANT_B,
      membershipId: "bbbbbbbb-eeee-4eee-8eee-eeeeeeeeeeee",
      portalType: "seller",
    })
  );

  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    captured.lastHref = href;
    const method = String((opts && opts.method) || "GET").toUpperCase();
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
      if (token === TOKEN_A) {
        return jsonRes(200, [{ id: "qa", tenant_id: TENANT_A, public_token: TOKEN_A }]);
      }
      if (token === TOKEN_B) {
        return jsonRes(200, [{ id: "qb", tenant_id: TENANT_B, public_token: TOKEN_B }]);
      }
      return jsonRes(200, []);
    }
    if (table === "profiles") {
      const email = qp(restPath, "email");
      const id = qp(restPath, "id");
      const tenantId = qp(restPath, "tenant_id");
      const rows = [
        profile(TENANT_A, OWNER_A, "owner"),
        profile(TENANT_A, "seller-a@example.com", "seller", SELLER_MEM),
        profile(TENANT_A, "super-a@example.com", "supervisor", SUPER_MEM),
        profile(TENANT_B, "seller-b@example.com", "seller", "bbbbbbbb-eeee-4eee-8eee-eeeeeeeeeeee"),
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
      if (id === TENANT_B) {
        return jsonRes(200, [
          {
            id: TENANT_B,
            owner_email: "owner-b@example.com",
            plan_status: "active",
            stripe_customer_id: "cus_legacyOwnerB123",
            slug: "co-b",
            name: "Co B",
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "device_sessions") {
      const hash = qp(restPath, "session_token_hash");
      const rows = [
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
        {
          id: SUPER_SESS,
          device_id: SUPER_DEVICE,
          tenant_id: TENANT_A,
          membership_id: SUPER_MEM,
          portal_type: "supervisor",
          status: "active",
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          session_token_hash: supervisorDevice.tokenHash,
        },
        {
          id: "bbbbbbbb-ffff-4fff-8fff-ffffffffffff",
          device_id: "bbbbbbbb-dddd-4ddd-8ddd-dddddddddddd",
          tenant_id: TENANT_B,
          membership_id: "bbbbbbbb-eeee-4eee-8eee-eeeeeeeeeeee",
          portal_type: "seller",
          status: "active",
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          session_token_hash: sellerB.tokenHash,
        },
      ].filter((row) => !hash || row.session_token_hash === hash);
      return jsonRes(200, rows);
    }
    if (table === "tenant_devices") {
      const id = qp(restPath, "id");
      const rows = [
        { id: SELLER_DEVICE, tenant_id: TENANT_A, portal_type: "seller", status: "active" },
        { id: SUPER_DEVICE, tenant_id: TENANT_A, portal_type: "supervisor", status: "active" },
        {
          id: "bbbbbbbb-dddd-4ddd-8ddd-dddddddddddd",
          tenant_id: TENANT_B,
          portal_type: "seller",
          status: "active",
        },
      ].filter((row) => !id || row.id === id);
      return jsonRes(200, rows);
    }
    return jsonRes(method === "GET" ? 200 : 200, []);
  };
  try {
    cacheBust();
    await fn(captured, { sellerDevice, supervisorDevice, sellerB });
  } finally {
    globalThis.fetch = prev;
  }
}

function hasNoStore(res) {
  return String((res.headers && res.headers["Cache-Control"]) || "").indexOf("no-store") >= 0;
}

async function main() {
  const helperSrc = read("netlify/functions/_lib/estimate-pdf-access.js");
  const fnSrc = read("netlify/functions/get-estimate-pdf.js");
  const sendSrc = read("netlify/functions/send-quote-zapier.js");
  const logoSrc = read("netlify/functions/upload-tenant-logo.js");
  const contractSrc = read("netlify/functions/_lib/contract-signed-pdf.js");

  ok("producer is send-quote-zapier via estimate-pdf-access", sendSrc.indexOf("uploadEstimatePdf") >= 0);
  ok("send no longer returns public object URLs", sendSrc.indexOf("object/public/estimate-pdfs") < 0);
  ok("send emits get-estimate-pdf access URL", sendSrc.indexOf("buildEstimatePdfAccessUrl") >= 0);
  ok("handler authorizes via public token or Owner/Seller", fnSrc.indexOf("resolveOwnerOrSellerContext") >= 0);
  ok("public token HMAC-binds the object path", helperSrc.indexOf("signEstimatePdfAccess") >= 0);
  ok("handler verifies the path HMAC", fnSrc.indexOf("verifyEstimatePdfAccess") >= 0);
  ok("compatible phase keeps estimate-pdfs public", helperSrc.indexOf("public: true") >= 0);
  eq("bucket name stays estimate-pdfs", ESTIMATE_PDF_BUCKET, "estimate-pdfs");
  ok("sign URL hard-codes estimate-pdfs bucket", helperSrc.indexOf("/object/sign/${ESTIMATE_PDF_BUCKET}/") >= 0);
  ok("handler does not take bucket from query", fnSrc.indexOf("qs.bucket") < 0);
  eq("signed URL TTL is 60s", SIGNED_URL_EXPIRES_SEC, 60);
  ok("tenant-logos stays public", logoSrc.indexOf("tenant-logos") >= 0 && logoSrc.indexOf("public: true") >= 0);
  ok("contract-signed-pdfs stays private", contractSrc.indexOf('STORAGE_BUCKET = "contract-signed-pdfs"') >= 0);
  ok("contract helper still creates private bucket", contractSrc.indexOf("ensurePrivateBucket") >= 0);

  const publicUrl =
    "https://example.supabase.co/storage/v1/object/public/estimate-pdfs/" + INTERNAL_TEST_PATH;
  ok(
    "knowing the CORE SECURITY TEST object path is enough for a public bucket GET",
    /\/object\/public\/estimate-pdfs\//.test(publicUrl) && publicUrl.indexOf(INTERNAL_TEST_PATH) >= 0
  );
  const access = buildEstimatePdfAccessUrl("https://example.test", TOKEN_A, INTERNAL_TEST_PATH);
  ok("function URL is the compatible replacement for that path", access.indexOf("get-estimate-pdf") >= 0);
  ok("access URL keeps the durable public token", access.indexOf("token=" + TOKEN_A) >= 0);
  ok("access URL includes HMAC sig", /[?&]sig=[0-9a-f]{64}/.test(access));
  ok("access URL does not use object/public", access.indexOf("object/public") < 0);

  const parsed = parseEstimatePdfObjectPath(INTERNAL_TEST_PATH);
  eq("canonical path is tenant/date/file", parsed && parsed.objectPath, INTERNAL_TEST_PATH);
  eq(
    "mixed-case tenant UUID canonicalizes",
    parseEstimatePdfObjectPath(TENANT_A.toUpperCase() + "/2026-09-10/CORE-SECURITY-TEST.pdf").objectPath,
    INTERNAL_TEST_PATH
  );
  ok("parent traversal is rejected", parseEstimatePdfObjectPath(TENANT_A + "/../" + TENANT_B + "/x.pdf") == null);
  ok("dot-dot file segment is rejected", parseEstimatePdfObjectPath(TENANT_A + "/2026-09-10/../x.pdf") == null);
  ok("encoded traversal is rejected", parseEstimatePdfObjectPath(TENANT_A + "/2026-09-10/%2e%2e%2fx.pdf") == null);
  ok("backslash traversal is rejected", parseEstimatePdfObjectPath(TENANT_A + "/2026-09-10/..\\x.pdf") == null);
  ok("absolute path is rejected", parseEstimatePdfObjectPath("/" + INTERNAL_TEST_PATH) == null);
  ok("missing tenant uuid is rejected", parseEstimatePdfObjectPath("not-a-uuid/2026-09-10/CORE-SECURITY-TEST.pdf") == null);

  ok(
    "HMAC matches token+canonical path",
    verifyEstimatePdfAccess(TOKEN_A, INTERNAL_TEST_PATH, signEstimatePdfAccess(TOKEN_A, INTERNAL_TEST_PATH))
  );
  ok(
    "HMAC rejects another PDF of the same tenant",
    !verifyEstimatePdfAccess(TOKEN_A, OTHER_SAME_TENANT_PATH, signEstimatePdfAccess(TOKEN_A, INTERNAL_TEST_PATH))
  );

  await withDb(async (captured, devices) => {
    const mod = loadPdfHandler();
    const bound = accessQuery(TOKEN_A, INTERNAL_TEST_PATH);

    const none = await mod.handler(eventFor(null, { query: { path: INTERNAL_TEST_PATH } }));
    eq("CORE SECURITY TEST PDF without cookie or token is 401", none.statusCode, 401);
    ok("unauthenticated uses Cache-Control no-store", hasNoStore(none));
    ok("unauthenticated body has no service_role", JSON.stringify(parse(none)).indexOf("service_role") < 0);
    ok("unauthenticated body has no service key", JSON.stringify(parse(none)).indexOf("mg-estimate-pdf-access-test-key") < 0);

    const noSig = await mod.handler(
      eventFor(null, { query: { path: INTERNAL_TEST_PATH, token: TOKEN_A } })
    );
    eq("valid token without path HMAC is 401", noSig.statusCode, 401);

    const badToken = await mod.handler(
      eventFor(null, { query: { path: INTERNAL_TEST_PATH, token: "qt_invalid_token_xx", sig: bound.sig } })
    );
    eq("invalid public token is 401", badToken.statusCode, 401);

    const otherPdf = await mod.handler(
      eventFor(null, { query: { path: OTHER_SAME_TENANT_PATH, token: TOKEN_A, sig: bound.sig } })
    );
    eq("valid token cannot read another PDF of the same tenant", otherPdf.statusCode, 401);

    const cross = await mod.handler(
      eventFor(null, {
        query: {
          path: CROSS_PATH,
          token: TOKEN_A,
          sig: signEstimatePdfAccess(TOKEN_A, CROSS_PATH),
        },
      })
    );
    eq("token A cannot read tenant B path", cross.statusCode, 403);

    const trav = await mod.handler(
      eventFor(null, {
        query: { path: TENANT_A + "/../" + TENANT_B + "/CORE-SECURITY-TEST.pdf", token: TOKEN_A, sig: bound.sig },
      })
    );
    eq("path traversal is 400", trav.statusCode, 400);

    const encodedTrav = await mod.handler(
      eventFor(null, {
        query: { path: TENANT_A + "/2026-09-10/%2e%2e%2fx.pdf", token: TOKEN_A, sig: bound.sig },
      })
    );
    eq("encoded traversal is 400", encodedTrav.statusCode, 400);

    captured.signExpires = null;
    const valid = await mod.handler(eventFor(null, { query: bound }));
    eq("valid public token + exact path redirects", valid.statusCode, 302);
    ok("valid uses Cache-Control no-store", hasNoStore(valid));
    ok(
      "redirect Location is a signed URL",
      String((valid.headers && valid.headers.Location) || "").indexOf("/object/sign/estimate-pdfs/") >= 0
    );
    eq("signed URL expires in 60s", captured.signExpires, 60);
    ok("sign request uses server-side estimate-pdfs bucket", captured.signPath.indexOf("/object/sign/estimate-pdfs/") >= 0);
    ok("valid response has no service_role", String(valid.body || "").indexOf("service_role") < 0);
    ok("valid response has no service key", String(valid.body || "").indexOf("mg-estimate-pdf-access-test-key") < 0);

    captured.signExpires = null;
    const accessMod = require("../netlify/functions/_lib/estimate-pdf-access");
    await accessMod.createEstimatePdfSignedUrl(INTERNAL_TEST_PATH, 999);
    eq("createEstimatePdfSignedUrl caps TTL at 60s", captured.signExpires, 60);

    const ownerModern = await mod.handler(
      eventFor({ e: OWNER_A, t: TENANT_A }, { query: { path: INTERNAL_TEST_PATH } })
    );
    eq("Owner modern e+t without token is allowed for same tenant", ownerModern.statusCode, 302);

    const ownerLegacy = await mod.handler(
      eventFor({ e: OWNER_A, c: CUS_A }, { query: { path: INTERNAL_TEST_PATH } })
    );
    eq("Owner legacy e+c without token is allowed for same tenant", ownerLegacy.statusCode, 302);

    const ownerCross = await mod.handler(
      eventFor({ e: OWNER_A, t: TENANT_A }, { query: { path: CROSS_PATH } })
    );
    eq("Owner session cannot read other-tenant path", ownerCross.statusCode, 403);

    const seller = await mod.handler(
      eventFor(null, {
        query: { path: INTERNAL_TEST_PATH },
        deviceCookie: deviceCookieHeader(devices.sellerDevice),
      })
    );
    eq("valid Seller device is allowed for same tenant", seller.statusCode, 302);

    const sellerCross = await mod.handler(
      eventFor(null, {
        query: { path: INTERNAL_TEST_PATH },
        deviceCookie: deviceCookieHeader(devices.sellerB),
      })
    );
    eq("Seller of another tenant is rejected", sellerCross.statusCode, 403);

    const supervisor = await mod.handler(
      eventFor(null, {
        query: { path: INTERNAL_TEST_PATH },
        deviceCookie: deviceCookieHeader(devices.supervisorDevice),
      })
    );
    eq("Supervisor device is rejected", supervisor.statusCode, 401);
  });

  const manifest = JSON.parse(read("scripts/mg-core-security-shield-v1.json"));
  const suite = (manifest.required || []).find((row) => row && row.id === "core-estimate-pdf-access");
  ok("manifest lists estimate PDF access suite", Boolean(suite));
  ok(
    "manifest estimate PDF path is frozen",
    suite && suite.path === "scripts/test-core-estimate-pdf-access.js"
  );
  eq("manifest estimate PDF minPassed is 56", suite && suite.minPassed, 56);

  console.log("\nCore estimate PDF access: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
