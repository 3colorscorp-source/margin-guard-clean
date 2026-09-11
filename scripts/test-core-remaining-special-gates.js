#!/usr/bin/env node
/**
 * Core Security — remaining special gates (Project Control, sales approval,
 * supervisor assignment, logo upload).
 * Groups stay separate: identity is hasOwnerSessionIdentity; responses/roles
 * are not collapsed into requireOwnerOrAdmin.
 * Isolated mocked Supabase only. No live Netlify, email, Zapier, or DB writes.
 * Run: node scripts/test-core-remaining-special-gates.js
 */
"use strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "mg-remaining-special-gates-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-remaining-special-gates-test-key";
delete process.env.ZAPIER_SALES_APPROVAL_WEBHOOK_URL;
delete process.env.ZAPIER_WEBHOOK_URL;

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const { buildSessionPayload, createSessionCookie } = require("../netlify/functions/_lib/session");

const PROJECT_CONTROL_FILES = [
  "apply-project-change-order.js",
  "archive-tenant-project.js",
  "delete-project-change-order.js",
  "delete-project-expense.js",
  "delete-project-report.js",
  "get-project-change-orders.js",
  "get-project-control-projects.js",
  "get-project-day-progress.js",
  "get-project-financial-detail.js",
  "get-project-migration-baseline.js",
  "get-project-snapshot.js",
  "recalc-project-profit.js",
  "save-project-change-order.js",
  "upsert-project-migration-baseline.js",
];

const SALES_APPROVAL_FILES = [
  "create-sales-approval.js",
  "get-sales-approvals.js",
  "update-sales-approval.js",
];

const SUPERVISOR_ASSIGNMENT_FILES = ["assign-supervisor-project.js"];
const LOGO_UPLOAD_FILES = ["upload-tenant-logo.js"];

const FINANCIAL_OWNER_ONLY = [
  "get-project-day-progress.js",
  "get-project-financial-detail.js",
  "get-project-snapshot.js",
];

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_A = "owner-a@example.com";
const OWNER_B = "owner-b@example.com";
const SELLER_A = "seller-a@example.com";
const SUPERVISOR_A = "supervisor-a@example.com";
const USER_A = "11111111-1111-4111-8111-111111111111";
const CUS_A = "cus_legacyOwnerA123";
const PROJECT_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUOTE_A = "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QUOTE_B = "44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXPENSE_A = "55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXPENSE_B = "66666666-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPORT_A = "77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPORT_B = "88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CO_A = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CO_B = "aaaa9999-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APPROVAL_A = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const APPROVAL_B = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const HANDLERS = [
  {
    group: "project-control",
    file: "apply-project-change-order.js",
    method: "POST",
    body: {},
    other: { body: { change_order_id: CO_B } },
  },
  {
    group: "project-control",
    file: "archive-tenant-project.js",
    method: "POST",
    body: {},
    other: { body: { project_id: PROJECT_B } },
  },
  {
    group: "project-control",
    file: "delete-project-change-order.js",
    method: "POST",
    body: {},
    other: { body: { change_order_id: CO_B } },
  },
  {
    group: "project-control",
    file: "delete-project-expense.js",
    method: "POST",
    body: {},
    other: { body: { expense_id: EXPENSE_B } },
  },
  {
    group: "project-control",
    file: "delete-project-report.js",
    method: "POST",
    body: {},
    other: { body: { report_id: REPORT_B } },
  },
  {
    group: "project-control",
    file: "get-project-change-orders.js",
    method: "GET",
    query: {},
    other: { query: { project_id: PROJECT_B } },
  },
  {
    group: "project-control",
    file: "get-project-control-projects.js",
    method: "GET",
    query: {},
    isolation: "list-projects",
  },
  {
    group: "project-control",
    file: "get-project-day-progress.js",
    method: "GET",
    query: {},
    other: { query: { project_id: PROJECT_B } },
    isolation: "day-progress",
  },
  {
    group: "project-control",
    file: "get-project-financial-detail.js",
    method: "GET",
    query: {},
    other: { query: { project_id: PROJECT_B } },
  },
  {
    group: "project-control",
    file: "get-project-migration-baseline.js",
    method: "GET",
    query: {},
    other: { query: { project_id: PROJECT_B } },
  },
  {
    group: "project-control",
    file: "get-project-snapshot.js",
    method: "GET",
    query: {},
    other: { query: { project_id: PROJECT_B } },
  },
  {
    group: "project-control",
    file: "recalc-project-profit.js",
    method: "POST",
    body: {},
    other: { body: { project_id: PROJECT_B } },
  },
  {
    group: "project-control",
    file: "save-project-change-order.js",
    method: "POST",
    body: { title: "CO" },
    other: { body: { project_id: PROJECT_B, title: "cross" } },
  },
  {
    group: "project-control",
    file: "upsert-project-migration-baseline.js",
    method: "POST",
    body: { estimated_total_days: 5 },
    other: { body: { project_id: PROJECT_B, estimated_total_days: 5 } },
  },
  {
    group: "sales-create",
    file: "create-sales-approval.js",
    method: "POST",
    body: { workers: "not-array" },
    other: {
      body: {
        workers: [],
        tenant_id: TENANT_B,
        project_name: "cross-tenant",
        offered_price: 1,
      },
    },
    isolation: "create-sales",
  },
  {
    group: "sales-read",
    file: "get-sales-approvals.js",
    method: "GET",
    query: {},
    isolation: "list-approvals",
  },
  {
    group: "sales-update",
    file: "update-sales-approval.js",
    method: "POST",
    body: { status: "approved" },
    other: { body: { approval_id: APPROVAL_B, status: "approved" } },
  },
  {
    group: "supervisor-assignment",
    file: "assign-supervisor-project.js",
    method: "POST",
    body: {},
    other: { body: { project_id: PROJECT_B } },
  },
  {
    group: "logo-upload",
    file: "upload-tenant-logo.js",
    method: "POST",
    body: { mime_type: "image/png", file_base64: PNG_1X1, tenant_id: TENANT_B },
    isolation: "logo",
  },
];

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
  const rest = s.indexOf("/rest/v1/");
  if (rest >= 0) return s.slice(rest + "/rest/v1/".length);
  return s;
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
    auth_user_id: USER_A,
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

function classifiedFiles() {
  return PROJECT_CONTROL_FILES.concat(SALES_APPROVAL_FILES)
    .concat(SUPERVISOR_ASSIGNMENT_FILES)
    .concat(LOGO_UPLOAD_FILES);
}

function isIncompleteDenied(res, group) {
  if (group === "sales-create") {
    return res.statusCode === 200 && parse(res).stage === "session";
  }
  return res.statusCode === 401;
}

function isRoleDenied(res, group) {
  const body = parse(res);
  if (group === "sales-create") {
    return res.statusCode === 200 && body.stage === "tenant_missing";
  }
  if (group === "sales-read" || group === "sales-update") {
    return res.statusCode === 422;
  }
  return res.statusCode === 404;
}

function authorizedPastSession(res, group) {
  if (group === "sales-create") {
    return res.statusCode === 200 && parse(res).stage !== "session";
  }
  return res.statusCode !== 401;
}

function otherTenantDenied(res, row, captured) {
  if (row.isolation === "list-projects") {
    const ids = (parse(res).projects || []).map((p) => p && p.id);
    return res.statusCode === 200 && ids.indexOf(PROJECT_B) < 0 && ids.indexOf(PROJECT_A) >= 0;
  }
  if (row.isolation === "list-approvals") {
    const ids = (parse(res).approvals || []).map((p) => p && p.id);
    return res.statusCode === 200 && ids.indexOf(APPROVAL_B) < 0 && ids.indexOf(APPROVAL_A) >= 0;
  }
  if (row.isolation === "day-progress") {
    const rows = parse(res).day_progress || [];
    return (
      (res.statusCode === 200 || res.statusCode === 403) &&
      !rows.some((r) => r && r.id === "day-b")
    );
  }
  if (row.isolation === "create-sales") {
    return captured.insertTenantId === TENANT_A && parse(res).ok === true;
  }
  if (row.isolation === "logo") {
    return (
      res.statusCode === 200 &&
      String(captured.logoPath || "").indexOf(TENANT_A + "/") === 0 &&
      String(captured.logoPath || "").indexOf(TENANT_B) < 0
    );
  }
  return res.statusCode === 403 || res.statusCode === 404;
}

async function withDb(fn) {
  const prev = globalThis.fetch;
  const captured = { insertTenantId: null, logoPath: "" };
  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const href = String(url);
    if (href.indexOf("/storage/v1/") >= 0) {
      if (href.indexOf("/storage/v1/object/") >= 0) {
        const marker = "/storage/v1/object/tenant-logos/";
        const idx = href.indexOf(marker);
        captured.logoPath = idx >= 0 ? decodeURIComponent(href.slice(idx + marker.length)) : href;
      }
      return jsonRes(href.indexOf("/storage/v1/bucket") >= 0 ? 409 : 200, { ok: true });
    }

    const restPath = extractPath(url);
    const table = restPath.split("?")[0];
    const tenantId = qp(restPath, "tenant_id");
    const id = qp(restPath, "id");
    const email = qp(restPath, "email");
    const roleEq = qp(restPath, "role");

    if (table === "profiles") {
      if (email === OWNER_A && (!tenantId || tenantId === TENANT_A) && (!roleEq || roleEq === "owner")) {
        return jsonRes(200, [profile(TENANT_A, OWNER_A, "owner")]);
      }
      if (email === OWNER_B && (!tenantId || tenantId === TENANT_B) && (!roleEq || roleEq === "owner")) {
        return jsonRes(200, [profile(TENANT_B, OWNER_B, "owner")]);
      }
      if (email === SELLER_A && (!tenantId || tenantId === TENANT_A)) {
        return jsonRes(200, [profile(TENANT_A, SELLER_A, "seller")]);
      }
      if (email === SUPERVISOR_A && (!tenantId || tenantId === TENANT_A)) {
        return jsonRes(200, [profile(TENANT_A, SUPERVISOR_A, "supervisor")]);
      }
      return jsonRes(200, []);
    }

    if (table === "tenants") {
      const cus = qp(restPath, "stripe_customer_id");
      if (cus === CUS_A || id === TENANT_A) {
        return jsonRes(200, [tenantRow(TENANT_A, OWNER_A, { stripe_customer_id: CUS_A })]);
      }
      if (id === TENANT_B) {
        return jsonRes(200, [tenantRow(TENANT_B, OWNER_B)]);
      }
      return jsonRes(200, []);
    }

    if (table === "tenant_projects") {
      const rows = [
        {
          id: PROJECT_A,
          tenant_id: TENANT_A,
          quote_id: QUOTE_A,
          project_name: "Alpha",
          status: "signed",
          notes: "alpha notes",
          estimated_days: 5,
          labor_budget: 1000,
          sale_price: 5000,
        },
        {
          id: PROJECT_B,
          tenant_id: TENANT_B,
          quote_id: QUOTE_B,
          project_name: "Bravo",
          status: "signed",
          notes: "secret b",
        },
      ];
      const hit = rows.filter((row) => {
        if (id && row.id !== id) return false;
        if (tenantId && row.tenant_id !== tenantId) return false;
        return true;
      });
      if (method === "PATCH" || method === "DELETE") return jsonRes(200, hit);
      return jsonRes(200, hit);
    }

    if (table === "quotes") {
      const rows = [
        { id: QUOTE_A, tenant_id: TENANT_A, status: "accepted" },
        { id: QUOTE_B, tenant_id: TENANT_B, status: "accepted" },
      ];
      return jsonRes(
        200,
        rows.filter((row) => {
          if (tenantId && row.tenant_id !== tenantId) return false;
          if (restPath.indexOf("id=in.(") >= 0) {
            return restPath.indexOf(row.id) >= 0;
          }
          if (id && !id.startsWith("in.") && row.id !== id) return false;
          return true;
        })
      );
    }

    if (table === "tenant_project_expenses") {
      const rows = [
        { id: EXPENSE_A, tenant_id: TENANT_A, project_id: PROJECT_A, amount: 10 },
        { id: EXPENSE_B, tenant_id: TENANT_B, project_id: PROJECT_B, amount: 99 },
      ];
      return jsonRes(
        200,
        rows.filter((row) => {
          if (id && row.id !== id) return false;
          if (tenantId && row.tenant_id !== tenantId) return false;
          return true;
        })
      );
    }

    if (table === "tenant_project_reports") {
      const rows = [
        { id: REPORT_A, tenant_id: TENANT_A, project_id: PROJECT_A, hours: 1, days: 1 },
        { id: REPORT_B, tenant_id: TENANT_B, project_id: PROJECT_B, hours: 9, days: 9 },
      ];
      return jsonRes(
        200,
        rows.filter((row) => {
          if (id && row.id !== id) return false;
          if (tenantId && row.tenant_id !== tenantId) return false;
          return true;
        })
      );
    }

    if (table === "tenant_project_change_orders") {
      const rows = [
        {
          id: CO_A,
          tenant_id: TENANT_A,
          project_id: PROJECT_A,
          status: "draft",
          client_price: 1,
        },
        {
          id: CO_B,
          tenant_id: TENANT_B,
          project_id: PROJECT_B,
          status: "draft",
          client_price: 999,
        },
      ];
      if (method === "POST") {
        let payload = {};
        try {
          payload = JSON.parse((opts && opts.body) || "{}");
        } catch (_err) {
          payload = {};
        }
        return jsonRes(201, [
          {
            id: "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaa99",
            tenant_id: payload.tenant_id,
            project_id: payload.project_id,
            title: payload.title,
            status: payload.status || "draft",
          },
        ]);
      }
      return jsonRes(
        200,
        rows.filter((row) => {
          if (id && row.id !== id) return false;
          if (tenantId && row.tenant_id !== tenantId) return false;
          return true;
        })
      );
    }

    if (table === "tenant_project_day_progress") {
      const projectId = qp(restPath, "project_id");
      const rows = [
        { id: "day-a", tenant_id: TENANT_A, project_id: PROJECT_A, day_number: 1, status: "pending" },
        { id: "day-b", tenant_id: TENANT_B, project_id: PROJECT_B, day_number: 1, status: "completed" },
      ];
      return jsonRes(
        200,
        rows.filter((row) => {
          if (tenantId && row.tenant_id !== tenantId) return false;
          if (projectId && row.project_id !== projectId) return false;
          return true;
        })
      );
    }

    if (table === "sales_approvals") {
      if (method === "POST") {
        let payload = {};
        try {
          payload = JSON.parse((opts && opts.body) || "{}");
        } catch (_err) {
          payload = {};
        }
        captured.insertTenantId = payload.tenant_id || null;
        return jsonRes(201, [{ id: APPROVAL_A, tenant_id: payload.tenant_id }]);
      }
      const rows = [
        { id: APPROVAL_A, tenant_id: TENANT_A, status: "requested" },
        { id: APPROVAL_B, tenant_id: TENANT_B, status: "requested" },
      ];
      const hit = rows.filter((row) => {
        if (id && row.id !== id) return false;
        if (tenantId && row.tenant_id !== tenantId) return false;
        return true;
      });
      return jsonRes(200, hit);
    }

    if (table === "tenant_snapshots" || table === "tenant_project_operational_snapshots") {
      return jsonRes(200, []);
    }

    if (table === "tenant_project_migration_baselines") {
      return jsonRes(200, []);
    }

    return jsonRes(200, []);
  };

  try {
    classifiedFiles()
      .map((file) => "../netlify/functions/" + file.replace(/\.js$/, ""))
      .concat([
        "../netlify/functions/_lib/supabase-admin",
        "../netlify/functions/_lib/membership-resolve",
        "../netlify/functions/_lib/owner-access",
        "../netlify/functions/_lib/tenant-for-session",
        "../netlify/functions/_lib/tenant-production-projects",
        "../netlify/functions/_lib/resolve-profile-role",
        "../netlify/functions/_lib/migration-baseline",
        "../netlify/functions/_lib/project-day-progress",
        "../netlify/functions/_lib/project-snapshot",
        "../netlify/functions/_lib/project-financial-detail",
      ])
      .forEach((rel) => {
        try {
          delete require.cache[require.resolve(rel)];
        } catch (_err) {
          /* optional */
        }
      });
    await fn(captured);
  } finally {
    globalThis.fetch = prev;
  }
}

async function main() {
  eq("Project Control has 14 gates", PROJECT_CONTROL_FILES.length, 14);
  eq("sales approval has 3 gates", SALES_APPROVAL_FILES.length, 3);
  eq("supervisor assignment has 1 gate", SUPERVISOR_ASSIGNMENT_FILES.length, 1);
  eq("logo upload has 1 gate", LOGO_UPLOAD_FILES.length, 1);
  eq("classified special gates stay 19", classifiedFiles().length, 19);

  const overlap = classifiedFiles().filter((file, idx, all) => all.indexOf(file) !== idx);
  eq("classified groups do not overlap", overlap.join(","), "");

  const jsFiles = gitJsFiles();
  const eAndCHits = jsFiles.filter((rel) => /!session\?\.e \|\| !session\?\.c/.test(read(rel))).sort();
  eq("no remaining e&&c session gates", eAndCHits.join(","), "");

  const classifiedSet = classifiedFiles()
    .map((file) => "netlify/functions/" + file)
    .sort()
    .join(",");
  eq(
    "handler list covers the frozen 19",
    classifiedSet,
    HANDLERS.map((row) => "netlify/functions/" + row.file)
      .slice()
      .sort()
      .join(",")
  );

  classifiedFiles().forEach((file) => {
    const src = read("netlify/functions/" + file);
    ok(file + " uses hasOwnerSessionIdentity", src.indexOf("hasOwnerSessionIdentity") >= 0);
    ok(file + " does not require session.c", src.indexOf("!session?.e || !session?.c") < 0);
    ok(
      file + " is not collapsed into requireOwnerOrAdmin",
      src.indexOf('require("./_lib/require-owner-or-admin")') < 0 &&
        src.indexOf("async function requireOwnerOrAdmin") < 0
    );
  });

  FINANCIAL_OWNER_ONLY.forEach((file) => {
    ok(
      file + " keeps owner-only financial role",
      read("netlify/functions/" + file).indexOf("roleMayAccessFinancialSnapshot") >= 0
    );
  });

  const createSrc = read("netlify/functions/create-sales-approval.js");
  ok("create-sales-approval keeps HTTP 200 session failures", createSrc.indexOf("stage: \"session\"") >= 0);
  ok("create-sales-approval keeps ok200 envelope", createSrc.indexOf("function ok200") >= 0);

  const getSalesSrc = read("netlify/functions/get-sales-approvals.js");
  const updateSalesSrc = read("netlify/functions/update-sales-approval.js");
  ok("get-sales-approvals keeps 401 Unauthorized", getSalesSrc.indexOf("json(401, { error: \"Unauthorized\" })") >= 0);
  ok("update-sales-approval keeps 401 Unauthorized", updateSalesSrc.indexOf("json(401, { error: \"Unauthorized\" })") >= 0);
  ok("get-sales-approvals keeps 422 tenant missing", getSalesSrc.indexOf("json(422") >= 0);
  ok(
    "sales get/update keep 422 bootstrap copy",
    getSalesSrc.indexOf("Cannot load approvals") >= 0 &&
      updateSalesSrc.indexOf("Cannot update approval") >= 0
  );

  const logoSrc = read("netlify/functions/upload-tenant-logo.js");
  ok("logo uses resolveTenantFromSession", logoSrc.indexOf("resolveTenantFromSession") >= 0);
  ok("logo no longer looks up tenant by stripe customer only", logoSrc.indexOf("stripe_customer_id=eq.") < 0);

  const assignSrc = read("netlify/functions/assign-supervisor-project.js");
  ok("supervisor assignment still writes supervisor_user_id", assignSrc.indexOf("supervisor_user_id") >= 0);
  ok("Project Control archive keeps 403 cross-tenant miss", read("netlify/functions/archive-tenant-project.js").indexOf("Project not found for this tenant") >= 0);

  const remainingSuite = read("scripts/test-core-remaining-modern-owner-gates.js");
  ok(
    "legacy remaining-gates suite no longer freezes these as e+c exceptions",
    remainingSuite.indexOf("netlify/functions/upload-tenant-logo.js") < 0 ||
      /const E_AND_C_EXCEPTIONS = \[\s*\];/.test(remainingSuite)
  );

  await withDb(async (captured) => {
    const modern = { e: OWNER_A, t: TENANT_A, u: USER_A };
    const legacy = { e: OWNER_A, c: CUS_A, u: USER_A };
    const emailOnly = { e: OWNER_A };
    const sellerSession = { e: SELLER_A, t: TENANT_A };
    const supervisorMembership = { e: SUPERVISOR_A, t: TENANT_A };
    const crossHint = { e: OWNER_A, t: TENANT_B };

    for (const row of HANDLERS) {
      const mod = loadHandler(row.file);
      const optsBase = { method: row.method, query: row.query, body: row.body };

      const none = await mod.handler(eventFor(null, optsBase));
      ok(row.file + " incomplete session denied", isIncompleteDenied(none, row.group));

      const email = await mod.handler(eventFor(emailOnly, optsBase));
      ok(row.file + " email-only session denied", isIncompleteDenied(email, row.group));

      const modernRes = await mod.handler(eventFor(modern, optsBase));
      ok(row.file + " modern owner is not rejected at session", authorizedPastSession(modernRes, row.group));

      const legacyRes = await mod.handler(eventFor(legacy, optsBase));
      ok(row.file + " legacy owner is not rejected at session", authorizedPastSession(legacyRes, row.group));

      const sellerRes = await mod.handler(eventFor(sellerSession, optsBase));
      ok(row.file + " Seller is denied", isRoleDenied(sellerRes, row.group));

      const supervisorMem = await mod.handler(eventFor(supervisorMembership, optsBase));
      ok(row.file + " Supervisor membership is denied", isRoleDenied(supervisorMem, row.group));

      const supervisorCookie = await mod.handler(
        eventFor(null, Object.assign({}, optsBase, { cookie: "mg_supervisor_device=supervisor-device-not-owner" }))
      );
      ok(row.file + " Supervisor device cookie is denied", isIncompleteDenied(supervisorCookie, row.group));

      const cross = await mod.handler(eventFor(crossHint, optsBase));
      ok(row.file + " owner A + tenant B hint is isolated", isRoleDenied(cross, row.group));

      captured.insertTenantId = null;
      captured.logoPath = "";
      const otherOpts = {
        method: row.method,
        query: (row.other && row.other.query) || row.query,
        body: (row.other && row.other.body) || row.body,
      };
      const otherRes = await mod.handler(eventFor(modern, otherOpts));
      ok(row.file + " other-tenant id is isolated", otherTenantDenied(otherRes, row, captured));
    }
  });

  const manifest = JSON.parse(read("scripts/mg-core-security-shield-v1.json"));
  const required = manifest.required || [];
  const suite = required.find((row) => row && row.id === "core-remaining-special-gates");
  ok("manifest lists remaining special gates suite", Boolean(suite));
  ok(
    "manifest remaining special gates path is frozen",
    suite && suite.path === "scripts/test-core-remaining-special-gates.js"
  );
  ok("manifest remaining special gates minPassed is 253", suite && suite.minPassed === 253);

  console.log("\nCore remaining special gates: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
