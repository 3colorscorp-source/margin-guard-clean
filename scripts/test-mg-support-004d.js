#!/usr/bin/env node
/**
 * MG-SUPPORT-004D — Support Admin soft dark form polish (UI only).
 * Usage: node scripts/test-mg-support-004d.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

let failed = 0;
let passed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log("PASS  " + name);
  } else {
    failed += 1;
    console.log("FAIL  " + name);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function extractCss(html) {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : "";
}

function composeBlock(css) {
  const start = css.indexOf(".si-compose textarea {");
  const end = css.indexOf(".si-compose textarea:focus");
  return start >= 0 && end > start ? css.slice(start, end) : "";
}

async function main() {
  const html = read("public/support-admin.html");
  const uiSrc = read("public/js/support-admin.js");
  const css = extractCss(html);
  const ta = composeBlock(css);
  const listSrc = read("netlify/functions/mg-support-admin-list-cases.js");
  const updateSrc = read("netlify/functions/mg-support-admin-update-case.js");

  assert(
    "1. textarea background is not pure white",
    /background: #d3d8e0/.test(ta) &&
      !/#fff\b|#ffffff|white/i.test(ta) &&
      !/background:\s*#fff/i.test(css)
  );
  assert(
    "2. textarea remains readable",
    /color: #111827/.test(ta) && /padding: 15px/.test(ta) && /font: inherit/.test(ta)
  );
  assert(
    "3. focus state is visible",
    /textarea:focus/.test(css) &&
      /box-shadow: 0 0 0 3px rgba\(96, 165, 250, 0\.22\)/.test(css) &&
      /border: 1px solid rgba\(96, 165, 250, 0\.72\)/.test(css) &&
      /background: #d7dbe2/.test(css)
  );
  assert(
    "4. both editable Support Admin textareas use same visual system",
    /id="siActionMessageInput"/.test(html) &&
      /id="siResolutionInput"/.test(html) &&
      /siActionCompose[\s\S]*si-compose[\s\S]*siActionMessageInput/.test(html) &&
      /siResolutionCompose[\s\S]*si-compose[\s\S]*siResolutionInput/.test(html) &&
      (css.match(/background: #d3d8e0/g) || []).length === 1
  );
  assert(
    "5. no backend request payload changed",
    /body = \{ case_id: state\.selected\.case_id, action: action \}/.test(uiSrc) &&
      !/status_version/.test(uiSrc) &&
      /JSON\.stringify\(body\)/.test(uiSrc)
  );
  assert(
    "6. modal dimensions unchanged",
    /width: min\(98vw, 1800px\)/.test(css) &&
      /height: 95dvh/.test(css) &&
      /width: 100vw/.test(css) &&
      /height: 100dvh/.test(css)
  );
  assert(
    "7. action buttons unchanged",
    /updateCase\("mark_in_review"\)/.test(uiSrc) &&
      /updateCase\("request_customer_action"\)/.test(uiSrc) &&
      /updateCase\("resolve"\)/.test(uiSrc) &&
      /id="siMarkInReview"/.test(html) &&
      /id="siRequestAction"/.test(html) &&
      /id="siResolve"/.test(html)
  );
  assert(
    "8. mobile layout unchanged",
    /@media \(max-width: 767px\)/.test(css) &&
      /border-radius: 0/.test(css) &&
      /min-height: 120px/.test(css)
  );
  assert("soft gray is in requested range", /#d3d8e0/.test(css) && /border-radius: 12px/.test(ta));
  assert("resize vertical only", /resize: vertical/.test(ta));
  assert("no horizontal overflow", /max-width: 100%/.test(ta) && /box-sizing: border-box/.test(ta));
  assert("helper text is quieter", /font-size: 0\.7rem/.test(css) && /justify-content: flex-end/.test(css));
  assert("non-editable cards stay dark", /si-issue/.test(css) && !/\.si-issue[^{]*\{[^}]*#d3d8e0/.test(css));
  assert("list/update APIs unchanged", /mg-support-admin-list-cases/.test(uiSrc) && /mg-support-admin-update-case/.test(uiSrc));
  assert("platform admin still required", /assertPlatformAdminSession/.test(listSrc) && /assertPlatformAdminSession/.test(updateSrc));
  assert("cache-bust 004d", /support-admin\.js\?v=004d/.test(html));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
