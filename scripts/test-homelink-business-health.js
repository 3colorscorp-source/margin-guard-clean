"use strict";

const assert = require("assert");
const health = require("../netlify/functions/homelink-business-health");

const sample = health.buildHealth({
  overheadMonthly: 4281,
  savingsTargetMonths: 12,
  cashOnHand: 19355.32,
  operatingBalance: 12517.45,
  savingsBalance: 885.04,
  profitPct: 30,
  wcPct: 7,
  ficaPct: 7.65,
  futaPct: 0.6,
  casuiPct: 3.4
});

assert.strictEqual(sample.health, 52);
assert.strictEqual(sample.operating, 100);
assert.strictEqual(sample.savings, 2);
assert.strictEqual(sample.profit, 30);
assert.strictEqual(sample.tax, 19);
assert.deepStrictEqual(Object.keys(sample), ["health", "operating", "profit", "tax", "savings"]);
assert.strictEqual(JSON.stringify(sample).includes("19355"), false);
assert.strictEqual(JSON.stringify(sample).includes("4281"), false);

const missing = health.buildHealth({
  overheadMonthly: null,
  savingsTargetMonths: 12,
  cashOnHand: 100,
  operatingBalance: 100,
  savingsBalance: 100,
  profitPct: null,
  wcPct: null,
  ficaPct: null,
  futaPct: null,
  casuiPct: null
});
assert.strictEqual(missing.health, null);
assert.strictEqual(missing.operating, null);
assert.strictEqual(missing.savings, null);
assert.strictEqual(missing.profit, null);
assert.strictEqual(missing.tax, null);

const emptyCash = health.buildHealth({
  overheadMonthly: 4000,
  savingsTargetMonths: 12,
  cashOnHand: 0,
  operatingBalance: 0,
  savingsBalance: 0,
  profitPct: 30
});
assert.strictEqual(emptyCash.health, 0);
assert.strictEqual(emptyCash.operating, 0);
assert.strictEqual(emptyCash.savings, 0);

function page(result) {
  return String(result && result.body ? result.body : "");
}

(async function () {
  const denied = await health.handler({
    httpMethod: "GET",
    queryStringParameters: {}
  }, {
    homeOrigin: "https://homelink-connect-app.netlify.app",
    requireOwnerOrAdmin: async function () {
      const err = new Error("Unauthorized");
      err.statusCode = 401;
      err.code = "no_session";
      throw err;
    }
  });
  assert.strictEqual(denied.statusCode, 200);
  assert.ok(page(denied).includes("#bh="));
  assert.ok(page(denied).includes("health%22%3Anull") || page(denied).includes("\"health\":null"));

  const forbidden = await health.handler({
    httpMethod: "GET",
    queryStringParameters: { tenant_id: "someone-else" }
  }, {
    homeOrigin: "https://homelink-connect-app.netlify.app",
    requireOwnerOrAdmin: async function () {
      throw new Error("should not run");
    }
  });
  assert.strictEqual(forbidden.statusCode, 400);

  const posted = await health.handler({ httpMethod: "POST", queryStringParameters: {} }, {
    homeOrigin: "https://homelink-connect-app.netlify.app"
  });
  assert.strictEqual(posted.statusCode, 405);

  const ready = await health.handler({
    httpMethod: "GET",
    queryStringParameters: {}
  }, {
    homeOrigin: "https://homelink-connect-app.netlify.app",
    requireOwnerOrAdmin: async function () {
      return { tenant: { id: "tenant-1" } };
    },
    loadHealth: async function () {
      return sample;
    }
  });
  assert.strictEqual(ready.statusCode, 200);
  const body = page(ready);
  assert.ok(body.includes("homelink-connect-app.netlify.app"));
  assert.ok(body.includes("52"));
  assert.strictEqual(body.includes("19355"), false);
  assert.strictEqual(body.includes("tenant-1"), false);
  console.log("ok homelink business health returns a percent and four levels");
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
