#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const {
  mapDeviceExpenseRow,
} = require("../netlify/functions/_lib/supervisor-device-field-dto");

const mapped = mapDeviceExpenseRow({
  id: "exp-1",
  project_id: "proj-1",
  tenant_id: "tenant-secret",
  expense_date: "2026-10-05",
  amount: 12.5,
  note: "tape",
  created_by: "owner-user",
  sale_price: 999,
  real_profit_total: 10,
});
assert.deepStrictEqual(
  Object.keys(mapped).sort(),
  ["amount", "expense_date", "id", "note", "project_id"]
);
assert.strictEqual(mapped.id, "exp-1");
assert.strictEqual(mapped.project_id, "proj-1");
assert.strictEqual(mapped.tenant_id, undefined);
assert.strictEqual(mapped.created_by, undefined);
assert.strictEqual(mapped.sale_price, undefined);
assert.strictEqual(mapped.real_profit_total, undefined);
assert.strictEqual(mapDeviceExpenseRow({ tenant_id: "t", amount: 1 }), null);

const app = fs.readFileSync(path.join(ROOT, "public/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "public/supervisor.html"), "utf8");
const endpoint = fs.readFileSync(
  path.join(ROOT, "netlify/functions/delete-supervisor-project-expense.js"),
  "utf8"
);
const ownerEndpoint = fs.readFileSync(
  path.join(ROOT, "netlify/functions/delete-project-expense.js"),
  "utf8"
);

assert(app.includes("Remove this expense? This action cannot be undone."));
assert(app.includes("/.netlify/functions/delete-supervisor-project-expense"));
assert(app.includes('class="btn danger sup-expense-remove"'));
assert(app.includes("sup-day-expense-row"));
assert(html.includes("<th>Action</th>"));
assert(html.includes(">Remove</button>") === false);
assert(endpoint.includes("resolveOwnerOrSupervisorContext"));
assert(endpoint.includes("loadTenantProjectForSupervisorAction"));
assert(endpoint.includes("unexpected_expense_total"));
assert(endpoint.includes("real_profit_total"));
assert(endpoint.includes("real_margin_pct"));
assert(ownerEndpoint.includes("hasOwnerSessionIdentity"));
assert(!ownerEndpoint.includes("resolveOwnerOrSupervisorContext"));
assert(!ownerEndpoint.includes("loadTenantProjectForSupervisorAction"));
assert(!ownerEndpoint.includes("project_id=eq."));

const filterFn = endpoint.slice(
  endpoint.indexOf("function expenseScopeFilter"),
  endpoint.indexOf("async function recalcSupervisorProjectExpenseTotals")
);
assert(filterFn.includes("id=eq."));
assert(filterFn.includes("&project_id=eq."));
assert(filterFn.includes("&tenant_id=eq."));

function queryValue(query, key) {
  const search = String(query).split("?")[1] || "";
  const part = search.split("&").find((item) => item.startsWith(key + "=eq."));
  if (!part) return "";
  return decodeURIComponent(part.slice((key + "=eq.").length));
}

async function runHandlerCases() {
  const guardPath = require.resolve("../netlify/functions/_lib/tenant-device-guard");
  const adminPath = require.resolve("../netlify/functions/_lib/supabase-admin");
  const handlerPath = require.resolve("../netlify/functions/delete-supervisor-project-expense");
  const TENANT = "tenant-a";
  const OTHER_TENANT = "tenant-b";
  const PROJECT = "project-a";
  const OTHER_PROJECT = "project-b";
  const EXPENSE = "expense-1";
  const OTHER_EXPENSE = "expense-2";
  const calls = [];
  const expenses = [
    { id: EXPENSE, project_id: PROJECT, tenant_id: TENANT, amount: 50 },
    { id: OTHER_EXPENSE, project_id: OTHER_PROJECT, tenant_id: TENANT, amount: 30 },
    { id: "expense-x", project_id: PROJECT, tenant_id: OTHER_TENANT, amount: 80 },
  ];
  let project = {
    id: PROJECT,
    tenant_id: TENANT,
    labor_consumed_total: 200,
    sale_price: 1000,
    applied_change_order_total: 0,
    projected_revenue_total: 1000,
  };

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
        if (query.startsWith("tenant_project_expenses?") && method === "GET") {
          if (query.includes("select=amount")) {
            return expenses
              .filter((row) => row.project_id === PROJECT && row.tenant_id === TENANT)
              .map((row) => ({ amount: row.amount }));
          }
          return expenses.filter(
            (row) =>
              row.id === queryValue(query, "id") &&
              row.project_id === queryValue(query, "project_id") &&
              row.tenant_id === queryValue(query, "tenant_id")
          );
        }
        if (query.startsWith("tenant_project_expenses?") && method === "DELETE") {
          const id = queryValue(query, "id");
          const projectId = queryValue(query, "project_id");
          const tenantId = queryValue(query, "tenant_id");
          const index = expenses.findIndex(
            (row) => row.id === id && row.project_id === projectId && row.tenant_id === tenantId
          );
          if (index < 0) throw new Error("delete matched nothing");
          expenses.splice(index, 1);
          return [];
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
  const { handler } = require("../netlify/functions/delete-supervisor-project-expense");

  const denied = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ expense_id: EXPENSE, project_id: OTHER_PROJECT }),
  });
  assert.strictEqual(denied.statusCode, 403);
  assert.strictEqual(expenses.length, 3);
  assert(!calls.some((call) => call.method === "DELETE"));

  calls.length = 0;
  const wrongProjectExpense = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ expense_id: OTHER_EXPENSE, project_id: PROJECT }),
  });
  assert.strictEqual(wrongProjectExpense.statusCode, 404);
  assert(expenses.some((row) => row.id === OTHER_EXPENSE));
  assert(!calls.some((call) => call.method === "DELETE"));

  const wrongTenant = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ expense_id: "expense-x", project_id: PROJECT }),
  });
  assert.strictEqual(wrongTenant.statusCode, 404);
  assert(expenses.some((row) => row.id === "expense-x"));

  const removed = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ expense_id: EXPENSE, project_id: PROJECT }),
  });
  assert.strictEqual(removed.statusCode, 200);
  const payload = JSON.parse(removed.body);
  assert.deepStrictEqual(payload, {
    ok: true,
    deleted: true,
    expense_id: EXPENSE,
    project_id: PROJECT,
  });
  assert.strictEqual(payload.tenant_id, undefined);
  assert.strictEqual(payload.real_profit_total, undefined);
  assert(!expenses.some((row) => row.id === EXPENSE));
  assert(expenses.some((row) => row.id === OTHER_EXPENSE));
  assert(expenses.some((row) => row.id === "expense-x"));
  assert.strictEqual(project.unexpected_expense_total, 0);
  assert.strictEqual(project.real_profit_total, 800);
  assert.strictEqual(project.real_margin_pct, 0.8);
  const deletedCall = calls.find((call) => call.method === "DELETE");
  assert(deletedCall.query.includes("id=eq." + encodeURIComponent(EXPENSE)));
  assert(deletedCall.query.includes("project_id=eq." + encodeURIComponent(PROJECT)));
  assert(deletedCall.query.includes("tenant_id=eq." + encodeURIComponent(TENANT)));
}

runHandlerCases()
  .then(() => {
    console.log("PASS supervisor delete expense");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
