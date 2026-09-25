/**
 * Contract Builder customer preview: toolbar must not cut a dark line through the paper.
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

const start = html.indexOf("body.cb-customer-preview {");
ok("customer preview CSS block exists", start >= 0);
const previewCss = start >= 0 ? html.slice(start, start + 900) : "";

ok(
  "preview clears hidden topbar offset",
  previewCss.includes("--mg-topbar-height: 0px")
);
ok(
  "preview toolbar has no full-width dark bar",
  previewCss.includes("background: transparent") &&
    previewCss.includes("border-bottom: none") &&
    previewCss.includes("backdrop-filter: none")
);
ok(
  "preview keeps Back/Edit/Print on a compact chip",
  previewCss.includes(".cb-toolbar__right") && previewCss.includes("border-radius: 12px")
);
ok(
  "preview toolbar sticks to the top of the viewport",
  previewCss.includes("position: sticky") && previewCss.includes("top: 0 !important")
);
ok(
  "preview shell does not reserve a second toolbar gap",
  previewCss.includes("padding-top: 12px")
);
ok(
  "builder toolbar still sits below the app topbar when not in preview",
  html.includes("top: var(--mg-topbar-height, 56px)")
);

console.log("\nContract Builder preview toolbar: " + passed + " passed");
