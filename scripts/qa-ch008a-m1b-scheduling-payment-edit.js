/**
 * CH-008A-M1B — Existing Quote Scheduling Payment edit (unit QA).
 * Run: node scripts/qa-ch008a-m1b-scheduling-payment-edit.js
 */
"use strict";

const assert = require("assert");
const {
  normalizeDepositRequiredForEdit,
  buildEditablePatch,
  ALLOWED_BODY_KEYS,
  EDITABLE_FIELD_NAMES,
  OWNER_ADMIN_ROLES,
} = require("../netlify/functions/update-tenant-quote-edit")._test;
const {
  preserveOrResolveSchedulingPayment,
} = require("../netlify/functions/_lib/quote-reprice-helpers");

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log(`PASS ${label}`);
}

const TOTAL = 14694.7;

// Field allowlist
ok("deposit_required editable", EDITABLE_FIELD_NAMES.includes("deposit_required"));
ok("deposit_required allowed body key", ALLOWED_BODY_KEYS.has("deposit_required"));
ok("owner/admin roles only", OWNER_ADMIN_ROLES.has("owner") && OWNER_ADMIN_ROLES.has("admin") && !OWNER_ADMIN_ROLES.has("seller"));

// A — 1469.47 → 1000
{
  const n = normalizeDepositRequiredForEdit(1000, TOTAL);
  ok("A normalize 1000", n.ok && n.amount === 1000);
  const patch = buildEditablePatch({ deposit_required: 1000 }, TOTAL);
  ok("A patch only deposit", patch.patch.deposit_required === 1000 && patch.updatedFields.length === 1);
  ok("A patch does not include total", !Object.prototype.hasOwnProperty.call(patch.patch, "total"));
}

// B — 1000 → 0
{
  const n = normalizeDepositRequiredForEdit(0, TOTAL);
  ok("B explicit 0", n.ok && n.amount === 0);
  ok("B string 0", normalizeDepositRequiredForEdit("0", TOTAL).ok && normalizeDepositRequiredForEdit("0", TOTAL).amount === 0);
}

// C — 0 → 1000
{
  const n = normalizeDepositRequiredForEdit(1000, TOTAL);
  ok("C 0→1000", n.ok && n.amount === 1000);
}

// D — omitted field does not change
{
  const patch = buildEditablePatch({ client_name: "Test" }, TOTAL);
  ok("D omit deposit", !Object.prototype.hasOwnProperty.call(patch.patch, "deposit_required"));
  ok("D updates name only", patch.updatedFields.includes("client_name") && !patch.updatedFields.includes("deposit_required"));
}

// E empty / F whitespace rejected
ok("E empty rejected", !normalizeDepositRequiredForEdit("", TOTAL).ok);
ok("F whitespace rejected", !normalizeDepositRequiredForEdit("   ", TOTAL).ok);

// G NaN / H negative / I over total
ok("G NaN rejected", !normalizeDepositRequiredForEdit(NaN, TOTAL).ok);
ok("H negative rejected", !normalizeDepositRequiredForEdit(-1, TOTAL).ok);
ok("I over total rejected", !normalizeDepositRequiredForEdit(15000, TOTAL).ok);

// J exact total accepted
{
  const n = normalizeDepositRequiredForEdit(TOTAL, TOTAL);
  ok("J exact total accepted", n.ok && n.amount === TOTAL);
}

// null rejected
ok("null rejected", !normalizeDepositRequiredForEdit(null, TOTAL).ok);

// M/N — patch cannot carry total/status
{
  const patch = buildEditablePatch(
    { deposit_required: 1000, total: 1, status: "accepted" },
    TOTAL
  );
  // unknown keys are rejected at handler level; buildEditablePatch ignores unknown
  ok("M patch has deposit only from editable keys", patch.patch.deposit_required === 1000);
  ok("N no total in patch object", patch.patch.total === undefined);
  ok("N no status in patch object", patch.patch.status === undefined);
}

// P — reprice still preserves after edit value
{
  const kept = preserveOrResolveSchedulingPayment(
    { total: TOTAL, deposit_required: 999, minimum_price: 1000 },
    1000,
    undefined
  );
  ok("P reprice preserves edited 1000", kept.ok && kept.financials.deposit_required === 1000);
}

// K/L documented as handler-level: OWNER_ADMIN_ROLES + tenant-scoped guard
ok("K/L security roles exclude seller/supervisor", !OWNER_ADMIN_ROLES.has("seller") && !OWNER_ADMIN_ROLES.has("supervisor"));

console.log(`\nCH-008A-M1B QA: ${passed} assertions passed`);
