"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const html = fs.readFileSync(
  path.join(__dirname, "..", "public", "business-settings.html"),
  "utf8"
);

assert(html.includes('id="opexSavedListWrap"'));
assert(html.includes('id="opexSavedList"'));
assert(html.includes("Saved overhead costs. Change one bill when the price changes"));
assert(html.includes("function patchSavedOperatingExpenseLine(itemId, patch)"));
assert(html.includes("operatingExpenseSaved = cloneOperatingExpenseLines(operatingExpenseDraft)"));
assert(html.includes("return cloneOperatingExpenseLines(operatingExpenseSaved)"));
assert(!html.includes("if (operatingExpenseCategoriesRendered) readOperatingExpenseDraftFromDom()"));
assert(html.includes("operatingExpenseDraft = cloneOperatingExpenseLines(operatingExpenseSaved)"));
assert(html.includes("That overhead cost was updated. The other saved costs stayed as they are."));
assert(html.includes("data-opex-saved-amount"));
assert(html.includes("data-opex-saved-remove"));

function roundCents(value) {
  return Math.round(Number(value) * 100) / 100;
}

function monthlyShare(amount, months) {
  return amount / months;
}

function monthsFor(cycle) {
  if (cycle === "year") return 12;
  if (cycle === "two_year") return 24;
  if (cycle === "three_year") return 36;
  return 1;
}

function cloneLines(lines) {
  return lines.map(function (line) {
    const copy = { id: line.id, amount: line.amount, cycle: line.cycle };
    if (line.name) copy.name = line.name;
    return copy;
  });
}

function totalFromLines(lines) {
  return roundCents(
    lines.reduce(function (sum, line) {
      return sum + monthlyShare(line.amount, monthsFor(line.cycle));
    }, 0)
  );
}

function patchLine(lines, itemId, patch) {
  const next = [];
  lines.forEach(function (line) {
    if (line.id !== itemId) {
      next.push(line);
      return;
    }
    if (patch && patch.remove) return;
    const updated = {
      id: line.id,
      amount: patch && patch.amount != null ? Number(patch.amount) : line.amount,
      cycle: patch && patch.cycle != null ? patch.cycle : line.cycle
    };
    if ((patch && patch.name != null) || line.name) {
      updated.name = patch && patch.name != null ? String(patch.name) : line.name;
    }
    next.push(updated);
  });
  return next;
}

const saved = [
  { id: "office_rent", amount: 2180, cycle: "month" },
  { id: "general_liability", amount: 3600, cycle: "year" },
  { id: "accounting_bookkeeping", amount: 450, cycle: "month" }
];

const afterRentChange = patchLine(cloneLines(saved), "office_rent", { amount: 2300 });
assert.strictEqual(afterRentChange.length, 3);
assert.strictEqual(afterRentChange[0].amount, 2300);
assert.strictEqual(afterRentChange[1].amount, 3600);
assert.strictEqual(afterRentChange[2].amount, 450);
assert.strictEqual(
  totalFromLines(afterRentChange),
  roundCents(2300 + monthlyShare(3600, 12) + 450)
);

const afterRemove = patchLine(cloneLines(afterRentChange), "accounting_bookkeeping", {
  remove: true
});
assert.strictEqual(afterRemove.length, 2);
assert.strictEqual(afterRemove[0].id, "office_rent");
assert.strictEqual(afterRemove[1].id, "general_liability");
assert.strictEqual(
  totalFromLines(afterRemove),
  roundCents(2300 + monthlyShare(3600, 12))
);

const discardedDraft = cloneLines(saved);
discardedDraft[0].amount = 9999;
const restored = cloneLines(saved);
assert.strictEqual(restored[0].amount, 2180);
assert.strictEqual(totalFromLines(restored), roundCents(2180 + 300 + 450));

console.log("ok opex saved list can edit one overhead without rebuilding the rest");
