#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(ROOT, "public/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "public/supervisor.html"), "utf8");
const endpoint = fs.readFileSync(
  path.join(ROOT, "netlify/functions/delete-supervisor-project-report.js"),
  "utf8"
);
const ownerEndpoint = fs.readFileSync(
  path.join(ROOT, "netlify/functions/delete-project-report.js"),
  "utf8"
);

assert(app.includes("confirmSupervisorLaborRemoval"));
assert(html.includes('id="supLaborRemoveModal"'));
assert(html.includes("Remove this labor report?"));
assert(html.includes("Keep report"));
assert(html.includes("This action cannot be undone."));
assert(app.includes("/.netlify/functions/delete-supervisor-project-report"));
assert(app.includes('class="btn danger sup-labor-remove"'));
assert(app.includes("sup-day-labor-row"));
assert(!app.includes('alert("Network error. Could not delete report.")'));
assert(endpoint.includes("resolveOwnerOrSupervisorContext"));
assert(endpoint.includes("loadTenantProjectForSupervisorAction"));
assert(endpoint.includes("labor_consumed_total"));
assert(endpoint.includes("real_profit_total"));
assert(endpoint.includes("real_margin_pct"));
assert(ownerEndpoint.includes("hasOwnerSessionIdentity"));
assert(!ownerEndpoint.includes("resolveOwnerOrSupervisorContext"));
assert(!ownerEndpoint.includes("loadTenantProjectForSupervisorAction"));

function queryValue(query, key) {
  const search = String(query).split("?")[1] || "";
  const part = search.split("&").find((item) => item.startsWith(key + "=eq."));
  if (!part) return "";
  return decodeURIComponent(part.slice((key + "=eq.").length));
}

async function runHandlerCases() {
  const guardPath = require.resolve("../netlify/functions/_lib/tenant-device-guard");
  const adminPath = require.resolve("../netlify/functions/_lib/supabase-admin");
  const handlerPath = require.resolve("../netlify/functions/delete-supervisor-project-report");
  const TENANT = "tenant-a";
  const OTHER_TENANT = "tenant-b";
  const PROJECT = "project-a";
  const OTHER_PROJECT = "project-b";
  const REPORT = "report-1";
  const OTHER_REPORT = "report-2";
  const calls = [];
  const reports = [
    { id: REPORT, project_id: PROJECT, tenant_id: TENANT, hours: 8 },
    { id: "report-keep", project_id: PROJECT, tenant_id: TENANT, hours: 4 },
    { id: OTHER_REPORT, project_id: OTHER_PROJECT, tenant_id: TENANT, hours: 6 },
    { id: "report-x", project_id: PROJECT, tenant_id: OTHER_TENANT, hours: 9 },
  ];
  let project = {
    id: PROJECT,
    tenant_id: TENANT,
    estimated_days: 2,
    labor_budget: 160,
    sale_price: 1000,
    applied_change_order_total: 0,
    projected_revenue_total: 1000,
  };
  const expenses = [{ project_id: PROJECT, tenant_id: TENANT, amount: 50 }];

  require.cache[guardPath] = {
    id: guardPath,
    filename: guardPath,
    loaded: true,
    exports: {
      async resolveOwnerOrSupervisorContext() {
        return { tenant: { id: TENANT }, auth_mode: "device" };
      },
      async loadTenantProjectForSupervisorAction(_ctx, projectId) {
        if (projectId !== PROJECT) {
          const err = new Error("Supervisor is not assigned to this project");
          err.isGuardError = true;
          err.statusCode = 403;
          err.code = "supervisor_not_assigned";
          throw err;
        }
        return { id: PROJECT, tenant_id: TENANT };
      },
    },
  };
  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: {
      async supabaseRequest(query, options) {
        const method = options && options.method ? options.method : "GET";
        calls.push({ query, method, body: options && options.body ? options.body : null });
        if (query.startsWith("tenant_project_reports?") && method === "GET") {
          if (query.includes("select=hours")) {
            return reports
              .filter((row) => row.project_id === PROJECT && row.tenant_id === TENANT)
              .map((row) => ({ hours: row.hours }));
          }
          return reports.filter(
            (row) =>
              row.id === queryValue(query, "id") &&
              row.project_id === queryValue(query, "project_id") &&
              row.tenant_id === queryValue(query, "tenant_id")
          );
        }
        if (query.startsWith("tenant_project_reports?") && method === "DELETE") {
          const id = queryValue(query, "id");
          const projectId = queryValue(query, "project_id");
          const tenantId = queryValue(query, "tenant_id");
          const index = reports.findIndex(
            (row) => row.id === id && row.project_id === projectId && row.tenant_id === tenantId
          );
          if (index < 0) throw new Error("delete matched nothing");
          reports.splice(index, 1);
          return [];
        }
        if (query.startsWith("tenant_project_expenses?") && method === "GET") {
          return expenses
            .filter((row) => row.project_id === PROJECT && row.tenant_id === TENANT)
            .map((row) => ({ amount: row.amount }));
        }
        if (query.startsWith("tenant_projects?") && method === "GET") return [project];
        if (query.startsWith("tenant_projects?") && method === "PATCH") {
          project = Object.assign({}, project, options.body);
          return [project];
        }
        throw new Error("unexpected query " + method + " " + query);
      },
    },
  };

  delete require.cache[handlerPath];
  const { handler } = require("../netlify/functions/delete-supervisor-project-report");

  const missing = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ project_id: PROJECT }),
  });
  assert.strictEqual(missing.statusCode, 400);

  const denied = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ report_id: REPORT, project_id: OTHER_PROJECT }),
  });
  assert.strictEqual(denied.statusCode, 403);
  assert.strictEqual(reports.length, 4);
  assert(!calls.some((call) => call.method === "DELETE"));

  calls.length = 0;
  const wrongProject = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ report_id: OTHER_REPORT, project_id: PROJECT }),
  });
  assert.strictEqual(wrongProject.statusCode, 404);
  assert(reports.some((row) => row.id === OTHER_REPORT));
  assert(!calls.some((call) => call.method === "DELETE"));

  const wrongTenant = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ report_id: "report-x", project_id: PROJECT }),
  });
  assert.strictEqual(wrongTenant.statusCode, 404);
  assert(reports.some((row) => row.id === "report-x"));

  const removed = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ report_id: REPORT, project_id: PROJECT }),
  });
  assert.strictEqual(removed.statusCode, 200);
  const payload = JSON.parse(removed.body);
  assert.deepStrictEqual(payload, {
    ok: true,
    deleted: true,
    report_id: REPORT,
    project_id: PROJECT,
  });
  assert.strictEqual(payload.tenant_id, undefined);
  assert.strictEqual(payload.labor_consumed_total, undefined);
  assert(!reports.some((row) => row.id === REPORT));
  assert(reports.some((row) => row.id === "report-keep"));
  assert(reports.some((row) => row.id === OTHER_REPORT));
  assert(reports.some((row) => row.id === "report-x"));
  assert.strictEqual(project.labor_consumed_total, 40);
  assert.strictEqual(project.unexpected_expense_total, 50);
  assert.strictEqual(project.real_profit_total, 910);
  assert.strictEqual(project.real_margin_pct, 0.91);
  const deletedCall = calls.find((call) => call.method === "DELETE");
  assert(deletedCall.query.includes("id=eq." + encodeURIComponent(REPORT)));
  assert(deletedCall.query.includes("project_id=eq." + encodeURIComponent(PROJECT)));
  assert(deletedCall.query.includes("tenant_id=eq." + encodeURIComponent(TENANT)));
}

runHandlerCases()
  .then(() => {
    console.log("PASS supervisor delete report");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
