#!/usr/bin/env node
/**
 * Core Security — remaining Owner/Admin gates accept modern email+tenant.
 * Isolated mocked Supabase only. No live Netlify, email, Zapier, or DB writes.
 * Run: node scripts/test-core-remaining-modern-owner-gates.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-remaining-modern-owner-gates-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-remaining-modern-owner-test-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

const DUMMY_UUID = "11111111-1111-4111-8111-111111111111";

const MIGRATED_HANDLERS = [
  { file: "archive-tenant-contact.js", method: "POST", body: {} },
  {
    file: "commit-tenant-contact-import.js",
    method: "POST",
    body: { confirm: true, batch_id: DUMMY_UUID },
  },
  { file: "preview-tenant-contact-import.js", method: "POST", body: {} },
  { file: "get-tenant-contact-360.js", method: "GET", query: {} },
  { file: "list-tenant-contact-quotes.js", method: "GET", query: {} },
  { file: "upsert-tenant-contact.js", method: "POST", body: {} },
  { file: "project-payment-intents.js", method: "GET", query: {} },
  { file: "project-intelligence.js", method: "GET", query: {} },
  { file: "project-contract-setup.js", method: "GET", query: {} },
  { file: "project-contract-payment-schedule.js", method: "GET", query: {} },
  { file: "resend-tenant-quote.js", method: "POST", body: {} },
  { file: "get-tenant-quote-reprice.js", method: "GET", query: {} },
  { file: "reprice-tenant-quote.js", method: "POST", body: {} },
];

const LOCAL_REQUIRE_OWNER_OR_ADMIN_ALLOWED = [
  "netlify/functions/_lib/require-owner-or-admin.js",
  "netlify/functions/get-tenant-quote-edit.js",
  "netlify/functions/update-tenant-quote-edit.js",
];

// Project Control, sales approval, supervisor assignment, and logo upload
// identity is frozen in scripts/test-core-remaining-special-gates.js.
const E_AND_C_EXCEPTIONS = [];

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const OWNER_B = "owner-b@example.com";
const SELLER_A = "seller-a@example.com";
const CUS_A = "cus_legacyOwnerA123";

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
  if (fields) {
    headers.cookie = cookieFor(fields);
  } else if (opts && opts.cookie) {
    headers.cookie = opts.cookie;
  }
  return {
    httpMethod: (opts && opts.method) || "GET",
    headers,
    queryStringParameters: (opts && opts.query) || {},
    body: opts && opts.body != null ? JSON.stringify(opts.body) : undefined,
  };
}

function extractPath(url) {
  const s = String(url);
  const idx = s.indexOf("/rest/v1/");
  return idx >= 0 ? s.slice(idx + "/rest/v1/".length) : s;
}

function qp(restPath, key) {
  const q = restPath.split("?")[1] || "";
  const part = q.split("&").find((p) => p.startsWith(key + "="));
  if (!part) return "";
  return decodeURIComponent(part.slice(key.length + 1).replace(/^eq\./, ""));
}

function profile(tenantId, email, role) {
  return {
    id: "prof-" + email.split("@")[0],
    tenant_id: tenantId,
    email,
    role: role || "owner",
    status: "active",
    auth_user_id: "11111111-1111-4111-8111-111111111111",
  };
}

function tenantRow(id, email, extras) {
  return {
    id,
    slug: id.slice(0, 8),
    name: "Co " + id.slice(0, 4),
    owner_email: email,
    plan_status: "active",
    stripe_customer_id: extras && extras.stripe_customer_id ? extras.stripe_customer_id : null,
    ...(extras || {}),
  };
}

function gitJsFiles() {
  const r = spawnSync("git", ["ls-files", "netlify/functions"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (!r || r.status !== 0) throw new Error("git ls-files failed");
  return String(r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && /\.js$/.test(s));
}

function loadHandler(file) {
  const rel = "../netlify/functions/" + file.replace(/\.js$/, "");
  delete require.cache[require.resolve(rel)];
  return require(rel);
}

function authorizedNot401(res) {
  return res.statusCode !== 401 && parse(res).code !== "no_session";
}

async function withDb(fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];

    if (table === "profiles") {
      const email = qp(restPath, "email");
      const tenantId = qp(restPath, "tenant_id");
      const roleEq = qp(restPath, "role");
      if (email === OWNER_A && (!tenantId || tenantId === TENANT_A) && (!roleEq || roleEq === "owner")) {
        return jsonRes(200, [profile(TENANT_A, OWNER_A, "owner")]);
      }
      if (email === OWNER_B && (!tenantId || tenantId === TENANT_B) && (!roleEq || roleEq === "owner")) {
        return jsonRes(200, [profile(TENANT_B, OWNER_B, "owner")]);
      }
      if (email === SELLER_A && tenantId === TENANT_A) {
        return jsonRes(200, [profile(TENANT_A, SELLER_A, "seller")]);
      }
      return jsonRes(200, []);
    }

    if (table === "tenants") {
      const id = qp(restPath, "id");
      const cus = qp(restPath, "stripe_customer_id");
      if (cus === CUS_A || id === TENANT_A) {
        return jsonRes(200, [tenantRow(TENANT_A, OWNER_A, { stripe_customer_id: CUS_A })]);
      }
      if (id === TENANT_B) {
        return jsonRes(200, [tenantRow(TENANT_B, OWNER_B)]);
      }
      return jsonRes(200, []);
    }

    return jsonRes(200, []);
  };

  try {
    [
      "../netlify/functions/_lib/supabase-admin",
      "../netlify/functions/_lib/membership-resolve",
      "../netlify/functions/_lib/owner-access",
      "../netlify/functions/_lib/tenant-for-session",
      "../netlify/functions/_lib/require-owner-or-admin",
      "../netlify/functions/_lib/quote-reprice-helpers",
    ]
      .concat(MIGRATED_HANDLERS.map((row) => "../netlify/functions/" + row.file.replace(/\.js$/, "")))
      .forEach((rel) => {
        try {
          delete require.cache[require.resolve(rel)];
        } catch (_err) {
          /* optional */
        }
      });
    await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const modern = { e: OWNER_A, t: TENANT_A };
  const legacy = { e: OWNER_A, c: CUS_A };
  const emailOnly = { e: OWNER_A };
  const sellerSession = { e: SELLER_A, t: TENANT_A };
  const crossHint = { e: OWNER_A, t: TENANT_B };

  MIGRATED_HANDLERS.forEach((row) => {
    const src = read("netlify/functions/" + row.file);
    ok(
      row.file + " uses central require-owner-or-admin",
      src.indexOf('require("./_lib/require-owner-or-admin")') >= 0 ||
        src.indexOf('require("./require-owner-or-admin")') >= 0 ||
        (src.indexOf("quote-reprice-helpers") >= 0 && src.indexOf("requireOwnerOrAdmin") >= 0)
    );
    ok(row.file + " no longer requires session.c", src.indexOf("!session?.e || !session?.c") < 0);
    ok(row.file + " has no local requireOwnerOrAdmin copy", src.indexOf("async function requireOwnerOrAdmin") < 0);
  });

  const helperSrc = read("netlify/functions/_lib/require-owner-or-admin.js");
  ok("central helper uses hasOwnerSessionIdentity", helperSrc.indexOf("hasOwnerSessionIdentity") >= 0);
  ok("central helper keeps owner+admin roles", helperSrc.indexOf('new Set(["owner", "admin"])') >= 0);
  ok(
    "quote-reprice-helpers uses central require-owner-or-admin",
    read("netlify/functions/_lib/quote-reprice-helpers.js").indexOf('require("./require-owner-or-admin")') >= 0
  );

  const upsertSrc = read("netlify/functions/upsert-tenant-contact.js");
  ok("upsert keeps seller device fallback", upsertSrc.indexOf("resolveOwnerOrSellerContext") >= 0);
  ok("upsert owner path wraps central helper", upsertSrc.indexOf("requireOwnerAdminAccess") >= 0);

  const quoteEditSrc = read("netlify/functions/get-tenant-quote-edit.js");
  const quoteUpdateSrc = read("netlify/functions/update-tenant-quote-edit.js");
  ok("get-tenant-quote-edit already uses modern identity", quoteEditSrc.indexOf("hasOwnerSessionIdentity") >= 0);
  ok("update-tenant-quote-edit already uses modern identity", quoteUpdateSrc.indexOf("hasOwnerSessionIdentity") >= 0);

  const jsFiles = gitJsFiles();
  const eAndCHits = jsFiles.filter((rel) => {
    const src = read(rel);
    return /!session\?\.e \|\| !session\?\.c/.test(src);
  }).sort();
  eq(
    "no remaining e&&c session gates",
    eAndCHits.join(","),
    E_AND_C_EXCEPTIONS.slice().sort().join(",")
  );

  const localCopies = jsFiles.filter((rel) => /async function requireOwnerOrAdmin/.test(read(rel))).sort();
  eq(
    "local requireOwnerOrAdmin copies are frozen",
    localCopies.join(","),
    LOCAL_REQUIRE_OWNER_OR_ADMIN_ALLOWED.slice().sort().join(",")
  );

  await withDb(async () => {
    for (const row of MIGRATED_HANDLERS) {
      const mod = loadHandler(row.file);
      const none = await mod.handler(
        eventFor(null, { method: row.method, query: row.query, body: row.body })
      );
      eq(row.file + " missing session is 401", none.statusCode, 401);

      const email = await mod.handler(
        eventFor(emailOnly, { method: row.method, query: row.query, body: row.body })
      );
      eq(row.file + " email-only is 401", email.statusCode, 401);
      ok(
        row.file + " email-only is not owner identity",
        parse(email).code === "no_session" || parse(email).code === "no_device_session"
      );

      const modernRes = await mod.handler(
        eventFor(modern, { method: row.method, query: row.query, body: row.body })
      );
      ok(row.file + " modern owner is not 401", authorizedNot401(modernRes));

      const legacyRes = await mod.handler(
        eventFor(legacy, { method: row.method, query: row.query, body: row.body })
      );
      ok(row.file + " legacy owner is not 401", authorizedNot401(legacyRes));

      const sellerRes = await mod.handler(
        eventFor(sellerSession, { method: row.method, query: row.query, body: row.body })
      );
      ok(
        row.file + " seller membership is denied",
        sellerRes.statusCode === 403 ||
          sellerRes.statusCode === 422 ||
          parse(sellerRes).code === "owner_required" ||
          parse(sellerRes).code === "tenant_not_found"
      );
      ok(row.file + " seller is not treated as missing session", parse(sellerRes).code !== "no_session");

      const supervisor = await mod.handler(
        eventFor(null, {
          method: row.method,
          query: row.query,
          body: row.body,
          cookie: "mg_supervisor_device=supervisor-device-not-owner",
        })
      );
      eq(row.file + " supervisor device cookie is 401", supervisor.statusCode, 401);

      const cross = await mod.handler(
        eventFor(crossHint, { method: row.method, query: row.query, body: row.body })
      );
      eq(row.file + " owner A + tenant B is tenant_not_found", parse(cross).code, "tenant_not_found");
    }
  });

  const manifest = JSON.parse(read("scripts/mg-core-security-shield-v1.json"));
  const required = manifest.required || [];
  const suite = required.find((row) => row && row.id === "core-remaining-modern-owner-gates");
  ok("manifest lists remaining modern owner gates suite", Boolean(suite));
  ok(
    "manifest remaining gates path is frozen",
    suite && suite.path === "scripts/test-core-remaining-modern-owner-gates.js"
  );
  ok("manifest remaining gates minPassed is 168", suite && suite.minPassed === 168);

  console.log("\nCore remaining modern owner gates: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
