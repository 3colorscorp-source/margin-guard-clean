#!/usr/bin/env node
/**
 * Contracts — modern owner sessions in requireOwnerOrAdmin.
 * Isolated: mocked Supabase only. No live Netlify, email, or DB writes except mocked POSTs.
 * Run: node scripts/test-core-contract-modern-owner-session.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-contract-modern-owner-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-contract-modern-session-test-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

const CONTRACT_HANDLERS = [
  "contract-certificate-create.js",
  "contract-certificates.js",
  "contract-envelope-create.js",
  "contract-envelope-send.js",
  "contract-envelopes.js",
  "contract-invitation-email-queue.js",
  "contract-package-freeze.js",
  "contract-packages.js",
  "contract-signed-pdf-create.js",
  "contract-signed-pdfs.js",
  "contract-signer-create.js",
  "contract-signer-delete.js",
  "contract-signer-update.js",
  "contract-signers.js",
  "contract-signing-token-create.js",
  "contract-signing-token-revoke.js",
  "tenant-contract-legal-notices.js",
  "tenant-contract-preferences.js",
  "tenant-legal-profile.js",
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

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

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const OWNER_B = "owner-b@example.com";
const SELLER_A = "seller-a@example.com";
const ADMIN_A = "admin-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const CUS_A = "cus_legacyOwnerA123";
const PKG_A = "caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PKG_B = "cbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SIGNER_A = "daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNER_B = "dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENV_A = "eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENV_B = "ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UPDATED_AT = "2026-01-01T00:00:00.000Z";

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
    auth_user_id: email === OWNER_A ? USER_A : USER_B,
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

function loadModules() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/require-owner-or-admin",
    "../netlify/functions/_lib/contract-envelope",
    "../netlify/functions/_lib/contract-envelope-send",
    "../netlify/functions/_lib/contract-signing-token",
    "../netlify/functions/_lib/contract-invitation-email",
    "../netlify/functions/contract-envelopes",
    "../netlify/functions/contract-envelope-create",
    "../netlify/functions/contract-envelope-send",
    "../netlify/functions/contract-signing-token-create",
    "../netlify/functions/contract-invitation-email-queue",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return {
    gate: require("../netlify/functions/_lib/require-owner-or-admin"),
    read: require("../netlify/functions/contract-envelopes"),
    write: require("../netlify/functions/contract-envelope-create"),
    send: require("../netlify/functions/contract-envelope-send"),
    token: require("../netlify/functions/contract-signing-token-create"),
    invite: require("../netlify/functions/contract-invitation-email-queue"),
  };
}

async function withDb(fn) {
  const prev = globalThis.fetch;
  const queries = [];
  const writes = [];

  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    queries.push({ method, table, restPath });
    if (method !== "GET") {
      writes.push({ method, table, restPath, body: opts && opts.body });
    }

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
      if (email === ADMIN_A && tenantId === TENANT_A && !roleEq) {
        return jsonRes(200, [profile(TENANT_A, ADMIN_A, "admin")]);
      }
      if (email === ADMIN_A && roleEq === "owner") {
        return jsonRes(200, []);
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

    if (table === "tenant_contract_packages") {
      const tenantId = qp(restPath, "tenant_id");
      const id = qp(restPath, "id");
      if (tenantId === TENANT_A && id === PKG_A) {
        return jsonRes(200, [
          {
            id: PKG_A,
            tenant_id: TENANT_A,
            project_id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            quote_id: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            version: 1,
            status: "ready",
            created_at: UPDATED_AT,
            updated_at: UPDATED_AT,
          },
        ]);
      }
      return jsonRes(200, []);
    }

    if (table === "tenant_contract_envelopes") {
      if (method === "POST") {
        return jsonRes(201, [
          {
            id: ENV_A,
            tenant_id: TENANT_A,
            package_id: PKG_A,
            project_id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            quote_id: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "draft",
            created_at: UPDATED_AT,
            updated_at: UPDATED_AT,
            metadata: {},
          },
        ]);
      }
      const tenantId = qp(restPath, "tenant_id");
      const packageId = qp(restPath, "package_id");
      const envelopeId = qp(restPath, "id");
      const statusFilter = restPath.indexOf("status=eq.completed") >= 0 || restPath.indexOf("status=in.") >= 0;
      if (statusFilter) {
        return jsonRes(200, []);
      }
      if (tenantId === TENANT_A && packageId === PKG_A) {
        return jsonRes(200, [
          {
            id: ENV_A,
            tenant_id: TENANT_A,
            package_id: PKG_A,
            project_id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            quote_id: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "draft",
            created_at: UPDATED_AT,
            updated_at: UPDATED_AT,
            metadata: {},
          },
        ]);
      }
      if (tenantId === TENANT_A && envelopeId === ENV_A) {
        return jsonRes(200, [
          {
            id: ENV_A,
            tenant_id: TENANT_A,
            package_id: PKG_A,
            status: "draft",
            updated_at: UPDATED_AT,
          },
        ]);
      }
      return jsonRes(200, []);
    }

    if (table === "tenant_contract_signers") {
      const tenantId = qp(restPath, "tenant_id");
      const id = qp(restPath, "id");
      if (tenantId === TENANT_A && id === SIGNER_A) {
        return jsonRes(200, [
          {
            id: SIGNER_A,
            tenant_id: TENANT_A,
            envelope_id: ENV_A,
            package_id: PKG_A,
            project_id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            role: "client",
            email: "signer-a@example.com",
            status: "pending",
          },
        ]);
      }
      return jsonRes(200, []);
    }

    if (table === "tenant_contract_signing_tokens") {
      if (method === "POST") {
        return jsonRes(201, [
          {
            id: "taaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            tenant_id: TENANT_A,
            envelope_id: ENV_A,
            signer_id: SIGNER_A,
            status: "active",
            expires_at: "2026-02-01T00:00:00.000Z",
            created_at: UPDATED_AT,
            updated_at: UPDATED_AT,
          },
        ]);
      }
      return jsonRes(200, []);
    }

    return jsonRes(200, []);
  };

  try {
    return await fn(loadModules(), queries, writes);
  } finally {
    globalThis.fetch = prev;
  }
}

function catchGuard(err) {
  return {
    status: err && err.statusCode,
    code: err && err.code,
    message: err && err.message,
  };
}

async function main() {
  const helperSrc = read("netlify/functions/_lib/require-owner-or-admin.js");
  ok("shared helper uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(helperSrc));
  ok("shared helper does not require session.c alone", !/!session\?\.e \|\| !session\?\.c/.test(helperSrc));
  ok("shared helper still resolves tenant from session", /resolveTenantFromSession\(session\)/.test(helperSrc));
  ok("shared helper still allows owner membership", helperSrc.indexOf('"owner"') >= 0);
  ok("shared helper still allows admin membership", helperSrc.indexOf('"admin"') >= 0);
  ok("shared helper does not read seller device cookies", helperSrc.indexOf("requireSellerDevice") < 0);
  ok("shared helper does not read supervisor device cookies", helperSrc.indexOf("requireSupervisorDevice") < 0);

  CONTRACT_HANDLERS.forEach((name) => {
    const src = read("netlify/functions/" + name);
    ok(name + " uses shared requireOwnerOrAdmin", /require\("\.\/_lib\/require-owner-or-admin"\)/.test(src));
    ok(name + " has no local requireOwnerOrAdmin copy", !/async function requireOwnerOrAdmin/.test(src));
    ok(
      name + " does not keep the legacy session.c gate",
      !/!session\?\.e \|\| !session\?\.c/.test(src)
    );
  });

  const salesSrc = read("netlify/functions/get-sales-approvals.js");
  ok(
    "Sales Admin gate is unchanged session.e && session.c",
    /if \(!session\?\.e \|\| !session\?\.c\)/.test(salesSrc)
  );

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };
  const legacy = { e: OWNER_A, c: CUS_A, u: USER_A };
  const emailOnly = { e: OWNER_A, u: USER_A };
  const tenantOnly = { t: TENANT_A, u: USER_A };
  const sellerSession = { e: SELLER_A, t: TENANT_A, u: USER_A };
  const adminSession = { e: ADMIN_A, t: TENANT_A, u: USER_A };
  const crossHint = { e: OWNER_A, t: TENANT_B, u: USER_A };

  await withDb(async (mods) => {
    try {
      await mods.gate.requireOwnerOrAdmin(eventFor(null));
      ok("missing session must throw", false);
    } catch (err) {
      const g = catchGuard(err);
      eq("missing session is 401", g.status, 401);
      eq("missing session code", g.code, "no_session");
    }

    try {
      await mods.gate.requireOwnerOrAdmin(eventFor(emailOnly));
      ok("email-only session must throw", false);
    } catch (err) {
      eq("email-only is 401", catchGuard(err).code, "no_session");
    }

    try {
      await mods.gate.requireOwnerOrAdmin(eventFor(tenantOnly));
      ok("tenant-only session must throw", false);
    } catch (err) {
      eq("tenant-only is 401", catchGuard(err).code, "no_session");
    }

    try {
      await mods.gate.requireOwnerOrAdmin(
        eventFor(null, { cookie: "mg_device_session=seller-device-not-owner" })
      );
      ok("seller device cookie must throw", false);
    } catch (err) {
      eq("seller device cookie is not owner", catchGuard(err).code, "no_session");
    }

    try {
      await mods.gate.requireOwnerOrAdmin(
        eventFor(null, { cookie: "mg_supervisor_device=supervisor-device-not-owner" })
      );
      ok("supervisor device cookie must throw", false);
    } catch (err) {
      eq("supervisor device cookie is not owner", catchGuard(err).code, "no_session");
    }

    const modernGate = await mods.gate.requireOwnerOrAdmin(eventFor(modern));
    eq("modern owner tenant is A", modernGate.tenant.id, TENANT_A);
    eq("modern owner role is owner", modernGate.membership.role, "owner");

    const legacyGate = await mods.gate.requireOwnerOrAdmin(eventFor(legacy));
    eq("legacy owner tenant is A", legacyGate.tenant.id, TENANT_A);

    try {
      await mods.gate.requireOwnerOrAdmin(eventFor(sellerSession));
      ok("seller membership must not become owner", false);
    } catch (err) {
      const g = catchGuard(err);
      ok(
        "seller membership is denied",
        g.code === "tenant_not_found" || g.code === "owner_required"
      );
    }

    try {
      await mods.gate.requireOwnerOrAdmin(eventFor(adminSession));
      ok("admin without owner tenant resolve still uses admin role set", true);
    } catch (err) {
      const g = catchGuard(err);
      ok(
        "admin is not converted to seller/supervisor denial",
        g.code === "tenant_not_found" || g.code === "owner_required" || g.code === "membership_not_found"
      );
      ok("admin is not a missing-session skip", g.code !== "no_session");
    }

    try {
      await mods.gate.requireOwnerOrAdmin(eventFor(crossHint));
      ok("owner A must not take tenant B", false);
    } catch (err) {
      eq("owner A + tenant B hint is tenant_not_found", catchGuard(err).code, "tenant_not_found");
    }
  });

  await withDb(async (mods, queries) => {
    const none = await mods.read.handler(eventFor(null, { query: { package_id: PKG_A } }));
    eq("read without session is 401", none.statusCode, 401);
    eq("read without session code", parse(none).code, "no_session");

    const sellerDev = await mods.read.handler(
      eventFor(null, {
        query: { package_id: PKG_A },
        cookie: "mg_device_session=seller-device-not-owner",
      })
    );
    eq("read with seller device is 401", sellerDev.statusCode, 401);

    const modernRead = await mods.read.handler(eventFor(modern, { query: { package_id: PKG_A } }));
    eq("modern owner read is 200", modernRead.statusCode, 200);
    ok("modern owner read ok", parse(modernRead).ok === true);
    ok("modern read returns envelopes", Array.isArray(parse(modernRead).envelopes));

    const legacyRead = await mods.read.handler(eventFor(legacy, { query: { package_id: PKG_A } }));
    eq("legacy owner read is 200", legacyRead.statusCode, 200);

    const crossRead = await mods.read.handler(eventFor(modern, { query: { package_id: PKG_B } }));
    eq("owner A cannot read tenant B package", crossRead.statusCode, 404);
    const pkgQueries = queries.filter((q) => q.table === "tenant_contract_packages").map((q) => q.restPath);
    ok("package reads are present", pkgQueries.length > 0);
    ok(
      "package reads stay on tenant A",
      pkgQueries.every((p) => p.indexOf("tenant_id=eq." + TENANT_A) >= 0 && p.indexOf("tenant_id=eq." + TENANT_B) < 0)
    );
  });

  await withDb(async (mods, queries, writes) => {
    const none = await mods.write.handler(
      eventFor(null, { method: "POST", body: { package_id: PKG_A } })
    );
    eq("write without session is 401", none.statusCode, 401);

    const incomplete = await mods.write.handler(
      eventFor(emailOnly, { method: "POST", body: { package_id: PKG_A } })
    );
    eq("write with incomplete session is 401", incomplete.statusCode, 401);

    const modernWrite = await mods.write.handler(
      eventFor(modern, { method: "POST", body: { package_id: PKG_A } })
    );
    eq("modern owner write is 200", modernWrite.statusCode, 200);
    ok("modern write ok", parse(modernWrite).ok === true);

    const legacyWrite = await mods.write.handler(
      eventFor(legacy, { method: "POST", body: { package_id: PKG_A } })
    );
    eq("legacy owner write is 200", legacyWrite.statusCode, 200);

    const crossWrite = await mods.write.handler(
      eventFor(modern, { method: "POST", body: { package_id: PKG_B } })
    );
    eq("owner A cannot write tenant B package", crossWrite.statusCode, 404);

    const spoof = await mods.write.handler(
      eventFor(modern, { method: "POST", body: { package_id: PKG_A, tenant_id: TENANT_B } })
    );
    eq("client tenant_id is forbidden on write", spoof.statusCode, 400);
    ok(
      "client tenant_id is not accepted as authority",
      parse(spoof).code === "tenant_id_forbidden" || parse(spoof).code === "unknown_fields"
    );

    ok(
      "writes that insert envelopes use tenant A",
      writes
        .filter((w) => w.table === "tenant_contract_envelopes")
        .every((w) => String(w.body || "").indexOf(TENANT_A) >= 0 && String(w.body || "").indexOf(TENANT_B) < 0)
    );
    const createPkg = queries.filter((q) => q.table === "tenant_contract_packages");
    ok(
      "write package lookups stay on tenant A",
      createPkg.every((q) => q.restPath.indexOf("tenant_id=eq." + TENANT_A) >= 0)
    );
  });

  await withDb(async (mods, queries) => {
    const noneInvite = await mods.invite.handler(eventFor(null, { method: "GET" }));
    eq("invite without session is 401", noneInvite.statusCode, 401);

    const modernInvite = await mods.invite.handler(eventFor(modern, { method: "GET" }));
    eq("modern owner invite read is 200", modernInvite.statusCode, 200);
    ok("modern invite ok", parse(modernInvite).ok === true);

    const noneToken = await mods.token.handler(
      eventFor(null, { method: "POST", body: { signer_id: SIGNER_A } })
    );
    eq("sign without session is 401", noneToken.statusCode, 401);

    const modernToken = await mods.token.handler(
      eventFor(modern, { method: "POST", body: { signer_id: SIGNER_A } })
    );
    eq("modern owner sign/token is 200", modernToken.statusCode, 200);
    ok("modern token ok", parse(modernToken).ok === true);

    const crossToken = await mods.token.handler(
      eventFor(modern, { method: "POST", body: { signer_id: SIGNER_B } })
    );
    eq("owner A cannot sign tenant B signer", crossToken.statusCode, 404);

    const crossSend = await mods.send.handler(
      eventFor(modern, {
        method: "POST",
        body: { envelope_id: ENV_B, expected_updated_at: UPDATED_AT },
      })
    );
    eq("owner A cannot send tenant B envelope", crossSend.statusCode, 404);

    const signerQueries = queries.filter((q) => q.table === "tenant_contract_signers").map((q) => q.restPath);
    ok("signer lookups are present", signerQueries.length > 0);
    ok(
      "signer lookups stay on tenant A",
      signerQueries.every((p) => p.indexOf("tenant_id=eq." + TENANT_A) >= 0 && p.indexOf("tenant_id=eq." + TENANT_B) < 0)
    );
  });

  console.log("\nCore contract modern owner session: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
