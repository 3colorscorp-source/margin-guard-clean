#!/usr/bin/env node
/**
 * publish-public-invoice — modern owner session (email + tenant, no session.c).
 * Isolated: mocked Supabase only. No live Netlify, email, SQL, Zapier, or production publish.
 * Run: node scripts/test-publish-public-invoice-modern-owner-session.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-publish-public-invoice-modern-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-publish-public-invoice-modern-session-test-key";
process.env.URL = process.env.URL || "https://example.test";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

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
const USER_A = "11111111-1111-4111-8111-111111111111";
const CUS_A = "cus_legacyPublishPublic1";
const QUOTE_A = "44444444-4444-4444-8444-aaaaaaaaaaaa";
const QUOTE_OTHER = "55555555-5555-4555-8555-bbbbbbbbbbbb";
const QUOTE_NO_TENANT = "66666666-6666-4666-8666-aaaaaaaaaaaa";
const PROJECT_A = "77777777-7777-4777-8777-aaaaaaaaaaaa";
const TAKEN_TOKEN = "inv_token_taken_123";
const NEW_INV = "88888888-8888-4888-8888-aaaaaaaaaaaa";

const FILE = "netlify/functions/publish-public-invoice.js";

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

function eventFor(fields, body) {
  return {
    httpMethod: "POST",
    headers: fields ? { cookie: cookieFor(fields), host: "example.test" } : { host: "example.test" },
    body: JSON.stringify(body || {}),
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

function loadHandler() {
  [
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/membership-resolve",
    "../netlify/functions/_lib/owner-access",
    "../netlify/functions/_lib/tenant-for-session",
    "../netlify/functions/_lib/tenant-display",
    "../netlify/functions/_lib/public-token",
    "../netlify/functions/publish-public-invoice",
  ].forEach((rel) => {
    try {
      delete require.cache[require.resolve(rel)];
    } catch (_e) {}
  });
  return require("../netlify/functions/publish-public-invoice");
}

function quoteRow(id, tenantId) {
  return {
    id,
    tenant_id: tenantId,
    project_name: "Job A",
    title: "Job A",
    client_name: "Client A",
    client_email: "client@example.com",
  };
}

const STANDALONE = {
  standalone_invoice: true,
  customer_name: "Client A",
  customer_email: "client@example.com",
  project_name: "Job A",
  amount: 100,
  paid_amount: 0,
  balance_due: 100,
};

async function withDb(fn) {
  const prev = globalThis.fetch;
  const gets = [];
  const posts = [];
  const writes = [];
  const zapierCalls = [];

  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const restPath = extractPath(url);
    if (/hooks\.zapier\.com/i.test(String(url))) {
      zapierCalls.push({ url: String(url), method });
      return jsonRes(200, { ok: true });
    }
    const table = restPath.split("?")[0];
    if (method !== "GET") {
      let body = null;
      try {
        body = opts && opts.body ? JSON.parse(opts.body) : null;
      } catch (_err) {
        body = opts && opts.body;
      }
      writes.push({ method, table, path: restPath.slice(0, 220), body });
      if (method === "POST" && table === "invoices") {
        posts.push(body);
        return jsonRes(200, [
          {
            id: NEW_INV,
            tenant_id: body && body.tenant_id ? body.tenant_id : null,
            public_token: body && body.public_token,
            quote_id: body && body.quote_id ? body.quote_id : null,
            project_id: body && body.project_id ? body.project_id : null,
          },
        ]);
      }
      return jsonRes(200, [{ id: "write-mock-1" }]);
    }

    gets.push({
      table,
      path: restPath,
      tenantId: qp(restPath, "tenant_id"),
      id: qp(restPath, "id"),
      stripeCustomerId: qp(restPath, "stripe_customer_id"),
    });

    if (table === "profiles") {
      const email = qp(restPath, "email");
      const tenantId = qp(restPath, "tenant_id");
      if (email === OWNER_A && (!tenantId || tenantId === TENANT_A)) {
        return jsonRes(200, [
          {
            id: "prof-a",
            tenant_id: TENANT_A,
            email: OWNER_A,
            role: "owner",
            status: "active",
            auth_user_id: USER_A,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenants") {
      const id = qp(restPath, "id");
      const cus = qp(restPath, "stripe_customer_id");
      if (cus === CUS_A || !id || id === TENANT_A) {
        return jsonRes(200, [
          {
            id: TENANT_A,
            slug: "tenant-a",
            name: "Tenant A",
            owner_email: OWNER_A,
            plan_status: "active",
            stripe_customer_id: CUS_A,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "tenant_branding") {
      return jsonRes(200, [
        {
          tenant_id: TENANT_A,
          business_name: "Tenant A Co",
          logo_url: "https://example.test/logo.png",
        },
      ]);
    }
    if (table === "invoices") {
      const token = qp(restPath, "public_token");
      if (token === TAKEN_TOKEN) {
        return jsonRes(200, [{ id: "existing-inv" }]);
      }
      return jsonRes(200, []);
    }
    if (table === "quotes") {
      const id = qp(restPath, "id");
      if (id === QUOTE_A) return jsonRes(200, [quoteRow(QUOTE_A, TENANT_A)]);
      if (id === QUOTE_OTHER) return jsonRes(200, [quoteRow(QUOTE_OTHER, TENANT_B)]);
      if (id === QUOTE_NO_TENANT) return jsonRes(200, [quoteRow(QUOTE_NO_TENANT, null)]);
      return jsonRes(200, []);
    }
    if (table === "tenant_projects") {
      const tenantId = qp(restPath, "tenant_id");
      const quoteId = qp(restPath, "quote_id");
      if (tenantId === TENANT_A && quoteId === QUOTE_A) {
        return jsonRes(200, [{ id: PROJECT_A }]);
      }
      return jsonRes(200, []);
    }
    return jsonRes(200, []);
  };

  try {
    return await fn(loadHandler(), { gets, posts, writes, zapierCalls });
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const src = read(FILE);
  ok("uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(src));
  ok("does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(src));
  ok("resolves tenant from session", /resolveTenantFromSession\(session\)/.test(src));
  ok(
    "does not look up tenant by session.c stripe_customer_id",
    !/stripe_customer_id=eq\.\$\{encodeURIComponent\(session\.c\)\}/.test(src) &&
      !/session\.c/.test(src)
  );
  ok("still stamps payload.tenant_id from resolved tenant", /tenant_id:\s*tenant\.id/.test(src));
  ok(
    "still blocks other-tenant quotes",
    /That estimate belongs to another account/.test(src)
  );
  ok(
    "still requires client tenant_id match",
    /tenant_id does not match the signed-in account/.test(src)
  );
  ok("still uses resolveProjectIdForQuote(tenant.id", /resolveProjectIdForQuote\(tenant\.id/.test(src));

  const modern = { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" };
  const legacy = { e: OWNER_A, c: CUS_A };

  await withDb(async (mod, { gets, posts, writes, zapierCalls }) => {
    const noCookie = await mod.handler(eventFor(null, STANDALONE));
    eq("no cookie is 401", noCookie.statusCode, 401);
    eq("no cookie error Unauthorized", parse(noCookie).error, "Unauthorized");

    const noIdentity = await mod.handler(eventFor({ e: OWNER_A, t: "", c: "" }, STANDALONE));
    eq("email-only session is 401", noIdentity.statusCode, 401);
    eq("no identity did not insert invoices", posts.length, 0);
    eq("no identity did not write", writes.length, 0);
    eq("no identity did not call Zapier", zapierCalls.length, 0);

    const modernGetsBefore = gets.length;
    const modernRes = await mod.handler(eventFor(modern, STANDALONE));
    const modernGets = gets.slice(modernGetsBefore);
    eq("modern e+t c empty is authorized (200)", modernRes.statusCode, 200);
    const modernBody = parse(modernRes);
    eq("modern standalone stamps tenant_id", modernBody.tenant_id, TENANT_A);
    eq("modern standalone flag", modernBody.standalone, true);
    ok("modern insert used resolved tenant_id", posts.some((p) => p && p.tenant_id === TENANT_A && !p.quote_id));
    ok(
      "modern session did not query tenants by stripe_customer_id",
      modernGets.every((g) => g.path.indexOf("stripe_customer_id=eq.") < 0)
    );

    const legacyRes = await mod.handler(eventFor(legacy, STANDALONE));
    eq("legacy e+c is authorized (200)", legacyRes.statusCode, 200);
    eq("legacy standalone stamps tenant_id", parse(legacyRes).tenant_id, TENANT_A);

    const mismatch = await mod.handler(
      eventFor(modern, Object.assign({}, STANDALONE, { tenant_id: TENANT_B }))
    );
    eq("body tenant_id mismatch is 403", mismatch.statusCode, 403);
    eq(
      "mismatch error text",
      parse(mismatch).error,
      "tenant_id does not match the signed-in account."
    );

    const otherQuote = await mod.handler(eventFor(modern, { quote_id: QUOTE_OTHER }));
    eq("quote from another tenant is 403", otherQuote.statusCode, 403);
    eq("other-tenant quote error", parse(otherQuote).error, "That estimate belongs to another account.");

    const missingScope = await mod.handler(eventFor(modern, { quote_id: QUOTE_NO_TENANT }));
    eq("quote missing tenant_id is 409", missingScope.statusCode, 409);
    ok(
      "missing-scope error mentions republish",
      /missing tenant scope; republish the estimate/.test(parse(missingScope).error || "")
    );

    const postsBeforeQuote = posts.length;
    const quoteLinked = await mod.handler(eventFor(modern, { quote_id: QUOTE_A }));
    eq("quote-linked invoice is 200", quoteLinked.statusCode, 200);
    const quoteBody = parse(quoteLinked);
    eq("quote-linked tenant_id", quoteBody.tenant_id, TENANT_A);
    eq("quote-linked quote_id", quoteBody.quote_id, QUOTE_A);
    eq("quote-linked is not standalone", quoteBody.standalone, false);
    const quoteInsert = posts[postsBeforeQuote];
    ok("quote-linked insert stamped tenant_id", quoteInsert && quoteInsert.tenant_id === TENANT_A);
    eq("quote-linked insert quote_id", quoteInsert.quote_id, QUOTE_A);
    eq("project_id stamped from tenant_projects", quoteInsert.project_id, PROJECT_A);
    ok(
      "tenant_projects lookup used resolved tenant_id",
      gets.some(
        (g) =>
          g.table === "tenant_projects" &&
          g.tenantId === TENANT_A &&
          qp(g.path, "quote_id") === QUOTE_A
      )
    );

    const collision = await mod.handler(
      eventFor(modern, Object.assign({}, STANDALONE, { public_token: TAKEN_TOKEN }))
    );
    eq("public token collision is 409", collision.statusCode, 409);
    ok(
      "collision error mentions omit public_token",
      /already in use/.test(parse(collision).error || "")
    );

    eq("Zapier unused", zapierCalls.length, 0);
    ok(
      "no empty stripe_customer_id tenant lookup",
      gets.every((g) => !/stripe_customer_id=eq\.(?:&|$)/.test(g.path))
    );
  });

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
