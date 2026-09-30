#!/usr/bin/env node
/**
 * Create Invoice description interpret — modern owner session.
 * Isolated: mocked OpenAI + Supabase. No live Netlify, email, or DB writes.
 * Run: node scripts/test-interpret-manual-invoice-description.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-manual-invoice-desc-session-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-manual-invoice-desc-session-test-key";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "mg-test-openai-key";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");
const { cleanDescription } = require("../netlify/functions/interpret-manual-invoice-description");

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
const OWNER_A = "owner-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";

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
    headers: fields ? { cookie: cookieFor(fields) } : {},
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
    "../netlify/functions/interpret-manual-invoice-description",
  ].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });
  return require("../netlify/functions/interpret-manual-invoice-description");
}

async function withNet(fn, { modelBody } = {}) {
  const prev = globalThis.fetch;
  let invoiceWrites = 0;
  let modelCalls = 0;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes("/v1/responses")) {
      modelCalls += 1;
      return jsonRes(200, {
        output_text: JSON.stringify(
          modelBody || {
            summary: "Voice changes are ready for review.",
            warnings: [],
            description: "Install a waterproofing membrane over 208 square feet.",
          }
        ),
      });
    }
    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    const method = String((init && init.method) || "GET").toUpperCase();
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
      if (!id || id === TENANT_A) {
        return jsonRes(200, [
          {
            id: TENANT_A,
            slug: "tenant-a",
            name: "Tenant A",
            owner_email: OWNER_A,
            plan_status: "active",
            stripe_customer_id: null,
          },
        ]);
      }
      return jsonRes(200, []);
    }
    if (table === "invoices") {
      if (method === "POST" || method === "PATCH") invoiceWrites += 1;
      return jsonRes(200, []);
    }
    return jsonRes(404, { message: "unmocked " + restPath });
  };
  try {
    return await fn(loadHandler(), { invoiceWrites: () => invoiceWrites, modelCalls: () => modelCalls });
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  const src = read("netlify/functions/interpret-manual-invoice-description.js");
  const appSrc = read("public/js/app.js");
  const html = read("public/estimates-invoices.html");

  ok("uses hasOwnerSessionIdentity", /hasOwnerSessionIdentity\(session\)/.test(src));
  ok("does not require session.c", !/session\?\.e \|\| !session\?\.c/.test(src));
  ok("never persists", /persisted: false/.test(src));
  ok("does not insert invoices", !/invoices\?/.test(src) && !/invoice_no/.test(src));
  ok("strips prices from proposed description", /USD\|MXN/.test(src));
  ok("hub page loads shared dictation helper", /voice-operational-plan\.js/.test(html));
  ok("create invoice modal has dictation controls", /hubManualDescMicNew/.test(appSrc) && /hubManualDescMicContinue/.test(appSrc));
  ok("create invoice modal has interpret and apply", /Interpret and review/.test(appSrc) && /Confirm and apply/.test(appSrc));
  ok("confirm apply writes description only", /transcript\.value = next/.test(appSrc) && /Create Invoice is still required to save/.test(appSrc));
  eq("cleanDescription strips dollar amounts", cleanDescription("Install membrane $1,200 USD"), "Install membrane");

  await withNet(async (handler, counters) => {
    const none = await handler.handler(eventFor(null, { transcript: "install membrane" }));
    eq("no cookie is 401", none.statusCode, 401);

    const short = await handler.handler(eventFor({ e: OWNER_A, t: TENANT_A, u: USER_A, c: "" }, { transcript: "hi" }));
    eq("short transcript is 400", short.statusCode, 400);

    const okRes = await handler.handler(
      eventFor(
        { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" },
        { transcript: "instala membrana en 208 pies, pro 66 horas", language: "en" }
      )
    );
    const body = parse(okRes);
    eq("modern owner interpret is 200", okRes.statusCode, 200);
    ok("interpret ok", body.ok === true);
    eq("does not persist", body.persisted, false);
    eq(
      "returns professional description",
      body.description,
      "Install a waterproofing membrane over 208 square feet."
    );
    eq("did not write invoices", counters.invoiceWrites(), 0);
    ok("called the model once", counters.modelCalls() === 1);
  });

  await withNet(
    async (handler) => {
      const priced = await handler.handler(
        eventFor(
          { e: OWNER_A, t: TENANT_A, u: USER_A, c: "" },
          { transcript: "install membrane and bill 1200 dollars" }
        )
      );
      const body = parse(priced);
      eq("price-stripped description", body.description, "Install the waterproofing membrane.");
    },
    {
      modelBody: {
        summary: "Ready",
        warnings: [],
        description: "Install the waterproofing membrane. $1,200 USD",
      },
    }
  );

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
