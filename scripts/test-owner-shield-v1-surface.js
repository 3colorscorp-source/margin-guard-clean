#!/usr/bin/env node
/**
 * Owner Shield V1 — structural visual + draft-state contracts for Dueño.
 * Isolated source/CSS assertions. No browser, Netlify, Supabase, Zapier, email, or quotes.
 * Run: node scripts/test-owner-shield-v1-surface.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PREMIUM_SELECTOR =
  "#ownerVoicePlanPreviewModal.owner-voice-plan-preview-modal #ownerVoicePlanTranscript";

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, label + " expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual));
  passed += 1;
  console.log("PASS " + label);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function sliceFrom(src, start, untilRe) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, "missing start: " + start.slice(0, 80));
  const rest = src.slice(i);
  if (!untilRe) return rest;
  const m = rest.search(untilRe);
  return m > 0 ? rest.slice(0, m) : rest;
}

function extractNormalizeOwnerWorkers(appJs) {
  const start = appJs.indexOf("function normalizeOwnerWorkers(workers)");
  const end = appJs.indexOf("function formatMoney", start);
  assert.ok(start >= 0 && end > start, "normalizeOwnerWorkers is extractable");
  return new Function(appJs.slice(start, end) + "; return normalizeOwnerWorkers;")();
}

const html = read("public/owner.html");
const appJs = read("public/js/app.js");
const css = read("public/styles.css");
const salesHtml = read("public/sales.html");

const premiumRule = sliceFrom(html, PREMIUM_SELECTOR + " {", /\n\s*#ownerVoicePlanPreviewModal\.owner-voice-plan-preview-modal #ownerVoicePlanTranscript::placeholder/);
const premiumFocus = sliceFrom(
  html,
  PREMIUM_SELECTOR + ":focus,",
  /\n\s*#ownerVoicePlanPreviewModal\.owner-voice-plan-preview-modal #ownerVoicePlanTranscript::selection/
);
const premiumMobile = sliceFrom(
  html,
  "@media (max-width: 740px) {",
  /\n\s*@media \(prefers-reduced-motion: reduce\)/
);
const laborPortrait = sliceFrom(
  html,
  "@media (max-width: 600px) and (orientation: portrait) {",
  /\n\s*\.owner-operational \.owner-op-dash__cards/
);
const loadOwnerSrc = sliceFrom(appJs, "function loadOwner() {", /\n  function saveOwner\(/);
const saveOwnerSrc = sliceFrom(appJs, "function saveOwner(state, metrics) {", /\n  \/\*\*/);
const resetSrc = sliceFrom(appJs, "function resetOwnerDraftToNewQuote() {", /\n  function resetOwnerQuoteStateForNewQuote\(/);

ok("1. textarea #ownerVoicePlanTranscript exists", /<textarea[\s\S]*?id="ownerVoicePlanTranscript"/.test(html));
ok("1. premium selector is exact", html.indexOf(PREMIUM_SELECTOR + " {") >= 0);
ok("1. transcript uses the premium modal-qualified selector", premiumRule.indexOf("display: block") >= 0);
ok("2. transcript background is not white", /background:[\s\S]*rgba\(6,\s*10,\s*20,\s*0\.82\)/.test(premiumRule));
ok("2. transcript layers var(--panel)", /var\(--panel\)/.test(premiumRule));
ok(
  "2. transcript fill is not a solid white background",
  !/background(?:-color)?:\s*#fff(?:fff)?\b/i.test(premiumRule) &&
    !/background(?:-color)?:\s*white\b/i.test(premiumRule)
);
ok("2. transcript color-scheme is dark", /color-scheme:\s*dark/.test(premiumRule));
ok("2. --panel token is a dark navy", /--panel:#0c1426/.test(css));
ok("2. --panel is not white", !/--panel:\s*#fff/i.test(css) && !/--panel:\s*white/i.test(css));
ok("3. caret uses --green", /caret-color:\s*var\(--green\)/.test(premiumRule));
ok("3. --green token is #22c55e", /--green:#22c55e/.test(css));
ok("3. focus border is green", /border-color:\s*rgba\(34,\s*197,\s*94,\s*0\.55\)/.test(premiumFocus));
ok("3. focus ring is green", /box-shadow:[\s\S]*rgba\(34,\s*197,\s*94,\s*0\.14\)/.test(premiumFocus));
ok("4. mobile transcript font-size is at least 16px", /font-size:\s*max\(16px,\s*var\(--mg-font-body\)\)/.test(premiumMobile));
ok("4. mobile transcript rule still uses the premium selector", premiumMobile.indexOf(PREMIUM_SELECTOR) >= 0);

ok("5. voice preview modal exists", /id="ownerVoicePlanPreviewModal"/.test(html) && /class="modal owner-voice-plan-preview-modal"/.test(html));
ok("5. Review & confirm plan button exists", /id="btnOwnerReviewConfirmOperationalPlan"/.test(html));
ok("5. Review & confirm plan label", /id="btnOwnerReviewConfirmOperationalPlan">Review &amp; confirm plan</.test(html));
ok("5. Confirm and apply button exists", /id="ownerVoicePlanPreviewConfirm"/.test(html));
ok("5. Confirm and apply label", />Confirm and apply</.test(html));
ok("5. Confirm and apply is disabled until Interpret", /id="ownerVoicePlanPreviewConfirm"[\s\S]*?disabled/.test(html));
ok("5. owner voice ids are not copied into sales.html", !/ownerVoicePlanTranscript|btnOwnerReviewConfirmOperationalPlan/.test(salesHtml));

ok("6. labor portrait cards media query exists", /@media \(max-width: 600px\) and \(orientation: portrait\)/.test(html));
ok("6. portrait labor rows are flex column cards", /table\.owner-labor-table tbody tr[\s\S]*display:\s*flex[\s\S]*flex-direction:\s*column/.test(laborPortrait));
ok("6. portrait labor rows have card radius", /table\.owner-labor-table tbody tr[\s\S]*border-radius:\s*14px/.test(laborPortrait));
ok("6. portrait labor wrap does not scroll sideways", /owner-labor-table-wrap\.supervisor-table-wrap[\s\S]*overflow-x:\s*visible/.test(laborPortrait));
ok("6. portrait labor table is display block / min-width 0", /table\.owner-labor-table \{\s*display:\s*block[\s\S]*min-width:\s*0/.test(laborPortrait));
ok("7. Acciones stay visible as a labeled card row", /tbody td:nth-child\(6\)::before \{ content: "Acciones"; \}/.test(laborPortrait));
ok("7. row-actions are a visible flex row", /\.row-actions \{\s*display:\s*flex[\s\S]*overflow:[\s\S]*visible/.test(laborPortrait) || /\.row-actions \{[\s\S]*display:\s*flex[\s\S]*width:\s*100%/.test(laborPortrait));
ok("7. action buttons overflow visible", /\.row-actions \.btn \{[\s\S]*overflow:\s*visible/.test(laborPortrait));
ok("7. action buttons have a 44px target", /\.row-actions \.btn \{[\s\S]*min-height:\s*44px/.test(laborPortrait));

ok("8. Dueño keeps Costo base column", /<th[\s\S]*owner-labor-th--rate[\s\S]*>Costo base</.test(html));
ok("8. Dueño keeps Costo labor column", /<th[\s\S]*owner-labor-th--labor[\s\S]*>Costo labor</.test(html));
ok("8. portrait still labels Costo base and Costo labor", /content: "Costo base"/.test(laborPortrait) && /content: "Costo labor"/.test(laborPortrait));
ok("8. portrait labor cost cell is not display:none", /td\[data-cell="labor"\] \{[\s\S]*display:\s*flex/.test(laborPortrait) && !/td\[data-cell="labor"\][\s\S]{0,80}display:\s*none/.test(laborPortrait));
ok("8. this is Owner cost visibility, not Seller hiding", /owner-labor-table/.test(laborPortrait) && !/sales-labor-table/.test(laborPortrait));

ok("9. transcript overflow-x is hidden", /overflow-x:\s*hidden/.test(premiumRule));
ok("9. transcript wraps long words", /overflow-wrap:\s*anywhere/.test(premiumRule) && /word-break:\s*break-word/.test(premiumRule));
ok("9. portrait labor cells min-width 0", /tbody td[\s\S]*min-width:\s*0/.test(laborPortrait));
ok("9. portrait labor / wrap max-width 100%", /max-width:\s*100%/.test(laborPortrait));
ok("9. portrait labor inputs are box-sized and 16px", /font-size:\s*16px/.test(laborPortrait) && /box-sizing:\s*border-box/.test(laborPortrait));

ok("10. active Owner key is mg_owner_v2", /const LS_OWNER = "mg_owner_v2"/.test(appJs));
ok("10. loadOwner reads LS_OWNER", /function loadOwner\(\) \{[\s\S]*readStore\(LS_OWNER, \{\}\)/.test(loadOwnerSrc));
ok("10. saveOwner writes LS_OWNER", /function saveOwner\(state, metrics\) \{[\s\S]*writeStore\(LS_OWNER,/.test(saveOwnerSrc));
ok("10. tenant snapshot list includes LS_OWNER", /const TENANT_STORAGE_KEYS = \[[\s\S]*LS_OWNER[\s\S]*\]/.test(appJs));
ok("10. mg_owner_v1 is not the active Owner key", !/const LS_OWNER = "mg_owner_v1"/.test(appJs));
ok("11. reset writes a new-quote slate", /function resetOwnerDraftToNewQuote\(\)/.test(appJs));
ok("11. reset clears projectName / client / notes / quoteId / plan", /projectName: ""/.test(resetSrc) && /clientName: ""/.test(resetSrc) && /quoteNotes: ""/.test(resetSrc) && /quoteId: ""/.test(resetSrc) && /operational_plan: \[\]/.test(resetSrc));
ok("11. reset keeps tenant_id from the previous draft", /fresh\.tenant_id = tid/.test(resetSrc) && /const prev = readStore\(LS_OWNER, \{\}\)/.test(resetSrc));
ok("11. resetOwnerQuoteStateForNewQuote delegates to the same reset", /function resetOwnerQuoteStateForNewQuote\(\) \{\s*resetOwnerDraftToNewQuote\(\);/.test(appJs));
ok("12. loadOwner merges DEFAULT_OWNER then saved", /\.\.\.DEFAULT_OWNER[\s\S]*\.\.\.saved/.test(loadOwnerSrc));
ok("12. loadOwner always renormalizes workers", /workers: normalizeOwnerWorkers\(/.test(loadOwnerSrc));
ok("12. saveOwner renormalizes workers before persist", /workers: normalizeOwnerWorkers\(state\.workers\)/.test(saveOwnerSrc));

const normalizeOwnerWorkers = extractNormalizeOwnerWorkers(appJs);
const legacyWorkers = normalizeOwnerWorkers([
  { name: "Ana", type: "installer", hours: 8, rate: 75 },
  { name: "Luis", type: "helper", hours: 4, rate: 45 },
  { name: "Pat", type: "unknown", hours: 1, rate: 99 },
]);
eq("12. legacy installer custom rate is cleared", legacyWorkers[0].rate, "");
eq("12. legacy helper custom rate is cleared", legacyWorkers[1].rate, "");
eq("12. unknown type becomes installer", legacyWorkers[2].type, "installer");
eq("12. empty workers list stays an array", extractNormalizeOwnerWorkers(appJs)(null).length, 0);
ok("12. names survive legacy-rate cleanup", legacyWorkers[0].name === "Ana" && legacyWorkers[1].name === "Luis");

console.log("\nOwner Shield V1 surface: " + passed + " passed");
