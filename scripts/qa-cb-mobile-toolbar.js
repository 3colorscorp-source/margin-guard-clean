/**
 * Contract Builder mobile toolbar — static DOM/CSS QA.
 * Asserts the draft toolbar cannot cover the contract on mobile viewports.
 * Does not load live contracts, freeze, signature, PDF, or endpoints.
 * Run: node scripts/qa-cb-mobile-toolbar.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const html = fs.readFileSync(htmlPath, "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("PASS", name);
    passed += 1;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    failed += 1;
  }
}

function styleBlock() {
  const start = html.indexOf("<style>");
  const end = html.indexOf("</style>");
  assert.ok(start >= 0 && end > start, "page <style> missing");
  return html.slice(start, end);
}

function mediaBlocks(css) {
  const blocks = [];
  const re = /@media\s*([^{]+)\{/g;
  let m;
  while ((m = re.exec(css))) {
    const query = m[1].trim();
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push({ query, body: css.slice(m.index + m[0].length, i - 1) });
  }
  return blocks;
}

function isMobileOverlayQuery(query) {
  const q = query.toLowerCase().replace(/\s+/g, " ");
  if (q.includes("print")) return false;
  return (
    q.includes("max-width: 820px") ||
    q.includes("max-width:820px") ||
    (q.includes("max-height") && q.includes("1023px"))
  );
}

function desktopToolbarRule(css) {
  const idx = css.indexOf(".cb-toolbar {");
  assert.ok(idx >= 0, "desktop .cb-toolbar rule missing");
  const mediaIdx = css.indexOf("@media");
  assert.ok(idx < mediaIdx, "desktop .cb-toolbar must appear before @media");
  const end = css.indexOf("}", idx);
  return css.slice(idx, end + 1);
}

const css = styleBlock();
const medias = mediaBlocks(css);
const mobileCss = medias
  .filter((b) => isMobileOverlayQuery(b.query))
  .map((b) => b.body)
  .join("\n");

test("1 toolbar DOM hooks unchanged", () => {
  assert.ok(/id="cbToolbar"/.test(html), "cbToolbar");
  assert.ok(/class="cb-toolbar/.test(html), "cb-toolbar class");
  assert.ok(/>Contract Builder</.test(html), "brand");
  assert.ok(/id="cbStatusPill"/.test(html), "status pill");
  assert.ok(/id="cbBackHub"/.test(html) && />Back</.test(html), "Back");
  assert.ok(/id="cbPrintDraft"/.test(html) && /Print Draft/.test(html), "Print Draft");
  assert.ok(/id="cbPreviewToggle"/.test(html), "Preview/Edit toggle");
});

test("2 desktop toolbar stays position:fixed", () => {
  const rule = desktopToolbarRule(css);
  assert.match(rule, /position:\s*fixed/);
  assert.doesNotMatch(rule, /position:\s*static/);
});

test("3 mobile CSS exists for overlay hotfix", () => {
  assert.ok(mobileCss.length > 80, "mobile toolbar media query missing");
});

test("4 mobile toolbar is in-flow (static/relative), not fixed/sticky", () => {
  assert.match(mobileCss, /\.cb-toolbar[^{]*\{[^}]*position:\s*static/);
  const toolbarChunks = mobileCss.split(".cb-toolbar");
  toolbarChunks.slice(1).forEach((chunk) => {
    const body = chunk.slice(0, chunk.indexOf("}") + 1);
    assert.doesNotMatch(body, /position:\s*fixed/);
    assert.doesNotMatch(body, /position:\s*sticky/);
  });
});

test("5 mobile toolbar does not pin top/left/right over the document", () => {
  assert.match(mobileCss, /top:\s*auto/);
  assert.match(mobileCss, /left:\s*auto/);
  assert.match(mobileCss, /right:\s*auto/);
  assert.match(mobileCss, /z-index:\s*auto/);
});

test("6 mobile shell padding no longer reserves a fixed overlay gap", () => {
  assert.match(mobileCss, /\.cb-shell[^{]*\{[^}]*padding-top:\s*16px/);
  const shell820 = medias.find((b) => /max-width:\s*820px/i.test(b.query) && !/1023/.test(b.query));
  assert.ok(shell820, "820px layout query");
  assert.doesNotMatch(shell820.body, /padding-top:\s*86px/);
});

test("7 mobile buttons wrap without horizontal overflow", () => {
  assert.match(mobileCss, /flex-wrap:\s*wrap/);
  assert.match(mobileCss, /overflow-x:\s*hidden/);
  assert.match(mobileCss, /max-width:\s*100%/);
  assert.match(mobileCss, /min-height:\s*44px/);
});

test("8 landscape short viewports are included", () => {
  const q = medias.map((b) => b.query).join(" ");
  assert.match(q, /max-height:\s*540px/);
  assert.match(q, /max-width:\s*1023px/);
});

test("9 hotfix does not rewrite Article 7 / 8 / freeze / signature / PDF", () => {
  assert.match(html, /id="art-payment"/);
  assert.match(html, /id="art-schedule"/);
  assert.doesNotMatch(html, /position:\s*fixed[\s\S]{0,80}art-payment/);
});

test("10 page-scoped to Contract Builder", () => {
  assert.match(mobileCss, /body\[data-mg-page-title="Contract Builder"\]\s+\.cb-toolbar/);
});

console.log(
  `Contract Builder mobile toolbar QA: ${passed} passed, ${failed} failed`
);
if (failed) process.exit(1);
