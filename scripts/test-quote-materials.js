#!/usr/bin/env node
/**
 * Permanent Owner + Seller quote materials. Pass-through cost, never invent prices.
 * Run: node scripts/test-quote-materials.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { calculateQuotePublishFinancials } = require("../netlify/functions/_lib/pricing-engine");
const mats = require("../public/js/quote-materials");

const ROOT = path.resolve(__dirname, "..");
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

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

checkSyntax("public/js/quote-materials.js");
checkSyntax("netlify/functions/_lib/pricing-engine.js");
checkSyntax("netlify/functions/publish-public-quote.js");
checkSyntax("netlify/functions/calc-secure-pricing.js");
ok("syntax ok", true);

const ownerHtml = read("public/owner.html");
const salesHtml = read("public/sales.html");
const appSrc = read("public/js/app.js");
const sendSrc = read("public/js/estimate-public-send.js");
const draftSrc = read("public/js/quote-draft-from-email.js");
const engineSrc = read("netlify/functions/_lib/pricing-engine.js");
const publishSrc = read("netlify/functions/publish-public-quote.js");
const calcSrc = read("netlify/functions/calc-secure-pricing.js");

ok("owner page has materials host", /id="ownerMaterialsSection"/.test(ownerHtml));
ok("seller page has materials host", /id="salesMaterialsSection"/.test(salesHtml));
ok("owner loads quote-materials.js", /quote-materials\.js/.test(ownerHtml));
ok("seller loads quote-materials.js", /quote-materials\.js/.test(salesHtml));
ok("owner draft stores material_lines", /material_lines/.test(appSrc) && /DEFAULT_OWNER/.test(appSrc));
ok("seller draft stores material_lines", /material_lines/.test(salesHtml));
ok("owner send copies material_lines", /syncOwnerDraftToSalesStateForPublicSend[\s\S]*material_lines/.test(appSrc));
ok("owner publish body includes material_lines", /material_lines: window\.MgQuoteMaterials/.test(appSrc));
ok("seller publish body includes material_lines", /material_lines: window\.MgQuoteMaterials/.test(salesHtml));
ok("estimate-public-send includes material_lines", /material_lines/.test(sendSrc));
ok("email draft mergeSeed", /mergeSeed/.test(draftSrc));
ok("pricing engine adds material cost", /contractorSubtotal/.test(engineSrc) && /material_cost/.test(engineSrc));
ok("publish parse keeps material_lines", /material_lines/.test(publishSrc));
ok("calc-secure-pricing parse keeps material_lines", /material_lines/.test(calcSrc));
ok("new quote clears owner materials", /material_lines: \[\]/.test(appSrc));
ok("new quote clears seller materials", /material_lines: \[\]/.test(salesHtml));

const contractor = mats.sanitizeMaterialLines([
  { name: "LATICRETE STRATA_MAT", provider: "contractor", quantity: 2, unit: "ea", unit_cost: 185.5 },
  { name: "Tile (client provided)", provider: "client", quantity: 12, unit: "box", unit_cost: 999 },
]);
eq("keeps two lines", contractor.length, 2);
eq("contractor line total", mats.lineTotal(contractor[0]), 371);
eq("client supplied stays zero", mats.lineTotal(contractor[1]), 0);
eq("contractor subtotal ignores client", mats.contractorSubtotal(contractor), 371);

const seeded = mats.seedFromText(
  "LATICRETE STRATA_MAT; tile and grout supplied by the client; thin-set mortar; Maverick Textured Slate Mosaic"
);
ok("seed names from notes", seeded.length >= 3);
ok("seed never invents unit cost", seeded.every((row) => Number(row.unit_cost) === 0));
ok(
  "client tile/grout marked client",
  seeded.some((row) => row.provider === "client" && /tile/i.test(row.name))
);
ok(
  "contractor names stay contractor",
  seeded.some((row) => row.provider === "contractor" && /STRATA/i.test(row.name))
);
eq(
  "contact lines are not seeded as materials",
  mats.seedFromText("Roland Zoller\n510-401-3609\nPlease review the attached PDFs.").length,
  0
);

const merged = mats.mergeSeed(contractor, "stone/grout sealer");
ok("merge keeps existing priced line", merged.some((row) => row.name === "LATICRETE STRATA_MAT" && row.unit_cost === 185.5));
ok("merge adds missing name at zero", merged.some((row) => /sealer/i.test(row.name) && row.unit_cost === 0));

const laborOnly = { recommended: 7374.65, minimum: 6555.24, negotiation: 6964.95, labor: 4000 };
const withMats = mats.applyToLaborTotals(laborOnly, 371);
eq("recommended adds materials", withMats.recommended, 7745.65);
eq("minimum adds materials", withMats.minimum, 6926.24);
eq("labor recommended stays labor", withMats.laborRecommended, 7374.65);
eq("labor cost unchanged", withMats.labor, 4000);

const settings = {
  hoursPerDay: 8,
  baseInstaller: 10,
  baseHelper: 5,
  wcPct: 0,
  ficaPct: 0,
  futaPct: 0,
  casuiPct: 0,
  stdHours: 0,
  overheadMonthly: 0,
  profitPct: 0,
  reservePct: 0,
  minimumMarginPct: 15,
};
const workers = [{ type: "installer", days: 1 }];
const laborFin = calculateQuotePublishFinancials({ workers, pricing_stage: 2 }, settings);
const matFin = calculateQuotePublishFinancials(
  {
    workers,
    pricing_stage: 2,
    material_lines: [
      { name: "STRATA_MAT", provider: "contractor", quantity: 2, unit_cost: 50 },
      { name: "Tile", provider: "client", quantity: 10, unit_cost: 40 },
    ],
  },
  settings
);
eq("labor-only total unchanged", laborFin.total, 80);
eq("materials add pass-through only", matFin.total, 180);
eq("client tile does not change total", matFin.material_cost, 100);
ok("materials do not change labor", matFin.labor === laborFin.labor);
ok("materials do not change before_profit", matFin.before_profit === laborFin.before_profit);

console.log("\n" + passed + " passed");
