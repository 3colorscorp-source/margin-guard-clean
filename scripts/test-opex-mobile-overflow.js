"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const html = fs.readFileSync(
  path.join(__dirname, "..", "public", "business-settings.html"),
  "utf8"
);

const mediaIdx = html.indexOf("@media (max-width:900px)");
assert(mediaIdx > 0, "canonical 900px breakpoint");
const mobileCss = html.slice(mediaIdx, html.indexOf("</style>", mediaIdx));
const desktopCss = html.slice(0, mediaIdx);

assert(html.includes('id="btnOpexOptions"'));
assert(html.includes('aria-label="Expense calculator options"'));
assert(html.includes('aria-expanded="false"'));
assert(html.includes('id="opexOptionsMenu"'));
assert(html.includes("How to choose expenses"));
assert(html.includes("View selected expenses ("));
assert(html.includes('id="opexMenuSelectedCount"'));
assert(html.includes('id="opexCompactSummary"'));
assert(html.includes("Monthly overhead:"));
assert(html.includes('id="opexCompactTotal"'));
assert(html.includes('id="opexCompactCount"'));
assert(html.includes('id="btnApplyOperatingExpenseTotal"'));
assert(html.includes("Apply Total to Monthly Overhead"));
assert(html.includes('id="opexSummaryPanel"'));
assert(html.includes("Prepared Monthly Cost"));
assert(html.includes("Selected cost list"));
assert(html.includes('id="opexHowToSheet"'));
assert(
  html.includes(
    "Enter each bill for the period you pay it. A yearly or multi-year bill is divided into a monthly cost."
  )
);
assert(
  html.includes(
    "Do not include job labor, project materials, payroll burden, Workers Comp, commissions, profit, or reserves."
  )
);

assert(desktopCss.includes(".bs-opex-menu-btn"));
assert(/display:\s*none/.test(desktopCss.slice(desktopCss.lastIndexOf(".bs-opex-menu-btn"))));
assert(!desktopCss.includes(".bs-opex-help:not(.is-open)"));
assert(!desktopCss.includes(".bs-opex-modal__summary:not(.is-open)"));
assert(desktopCss.includes(".bs-opex-modal__subtitle"));
assert(desktopCss.includes(".bs-opex-modal__summary"));

assert(mobileCss.includes(".bs-opex-menu-btn"));
assert(mobileCss.includes("min-width:44px"));
assert(mobileCss.includes("min-height:44px"));
assert(mobileCss.includes(".bs-opex-help:not(.is-open)"));
assert(mobileCss.includes(".bs-opex-modal__summary:not(.is-open)"));
assert(mobileCss.includes("display:none"));
assert(mobileCss.includes(".bs-opex-compact-summary"));
assert(mobileCss.includes("position:sticky"));

assert(html.includes("setText('opexCompactCount', String(selections.length))"));
assert(html.includes("setText('opexMenuSelectedCount', String(selections.length))"));
assert(html.includes("setText('opexCompactTotal', formatOpexMoney(monthlyTotal))"));
assert(html.includes("setText('opexPreparedMonthlyCost', formatOpexMoney(monthlyTotal))"));
assert(html.includes("setText('opexSelectedCount', String(selections.length))"));
assert(html.includes("openOpexSelectedSheet"));
assert(html.includes("openOpexHowToSheet"));
assert(html.includes("closeOpexOptionsMenu"));
assert(html.includes("closeOpexSheets"));
assert(html.includes("isOpexMenuOpen()"));
assert(html.includes("isOpexSheetOpen()"));
assert(html.includes('if (event.key !== \'Escape\') return;'));
assert(html.includes("opexOptionsButton()?.focus()"));
assert(html.includes("toggleOpexOptionsMenu"));

assert(html.includes("return amount / opexCycleById(cycleId).months"));
assert(html.includes("function calculateOperatingExpenseTotal()"));
assert(html.includes("return sum + row.monthly"));
assert(html.includes("stdHours > 0 ? formatOpexMoney(monthlyTotal / stdHours)"));
assert(html.includes("setInputValue('overheadMonthly', total)"));
assert(!html.includes("operatingExpenseDraft = selections"));

console.log("ok opex mobile overflow menu keeps one calculator state");
