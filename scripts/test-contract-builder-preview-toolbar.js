/**
 * Contract Builder customer preview — ultra-pro document studio.
 * Isolated source assertions. No live Netlify/Supabase.
 * Run: node scripts/test-contract-builder-preview-toolbar.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public/contract-builder.html"), "utf8");

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function sliceFrom(startToken, endToken) {
  const i = html.indexOf(startToken);
  assert.ok(i >= 0, "missing " + startToken);
  const rest = html.slice(i);
  const j = rest.indexOf(endToken);
  return j > 0 ? rest.slice(0, j) : rest.slice(0, 4000);
}

const previewCss = sliceFrom(
  "/* Customer preview: document studio, not the builder chrome. */",
  ".cb-legal-banner {"
);

ok("customer preview CSS block exists", previewCss.length > 200);
ok("preview clears hidden topbar offset", previewCss.includes("--mg-topbar-height: 0px"));
ok("preview uses a light document studio background", previewCss.includes("#d6d1c7"));
ok(
  "preview hides builder brand and draft pill",
  previewCss.includes(".cb-toolbar__left")
);
ok(
  "preview hides the internal draft notice article",
  previewCss.includes("#art-notice")
);
ok(
  "preview toolbar is a floating action chip",
  previewCss.includes("position: fixed") &&
    previewCss.includes("right: 18px") &&
    previewCss.includes("background: transparent")
);
ok(
  "preview actions sit on a compact light chip",
  previewCss.includes("border-radius: 999px") &&
    previewCss.includes("rgba(255, 252, 247, 0.94)")
);
ok(
  "preview paper is letter-width with a document shadow",
  previewCss.includes("max-width: 816px") && previewCss.includes("0 18px 50px")
);
ok(
  "builder toolbar still sits below the app topbar when not in preview",
  html.includes("top: var(--mg-topbar-height, 56px)")
);

console.log("\nContract Builder preview toolbar: " + passed + " passed");
