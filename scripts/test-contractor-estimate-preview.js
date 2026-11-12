#!/usr/bin/env node
/**
 * Contractor preview of the public estimate must not claim first_view_tracked_at.
 * Run: node scripts/test-contractor-estimate-preview.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let passed = 0;

function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const trackSrc = read("netlify/functions/track-estimate-view.js");
const publicSrc = read("public/estimate-public.html");

ok("track uses owner/seller session", /resolveOwnerOrSellerContext/.test(trackSrc));
ok("track looks up quote tenant before claim", /select=tenant_id/.test(trackSrc));
ok(
  "contractor skip returns before PATCH",
  trackSrc.indexOf("resolveContractorPreviewSkip") < trackSrc.indexOf("FIRST CLAIM ATTEMPT") &&
    trackSrc.indexOf("contractor_preview") < trackSrc.indexOf('method: "PATCH"')
);
ok("skip payload is contractor_preview", /skipped:\s*"contractor_preview"/.test(trackSrc));
ok("public fetch sends session cookies", /credentials:\s*"include"/.test(publicSrc));
ok("public page shows contractor banner", /showContractorPreviewBanner/.test(publicSrc) && /Contractor preview/.test(publicSrc));
ok("contractor skip does not use localStorage already_tracked", /skipped === "contractor_preview"[\s\S]*showContractorPreviewBanner/.test(publicSrc));

const helperSrc = read("public/js/quote-contractor-preview.js");
const ownerHtml = read("public/owner.html");
const salesHtml = read("public/sales.html");
const appSrc = read("public/js/app.js");
ok("preview helper uses a key that survives New Quote", /mg_contractor_quote_preview_v1/.test(helperSrc) && !/resetOwnerDraftToNewQuote[\s\S]*mg_contractor_quote_preview/.test(appSrc));
ok("owner has Preview client quote", /id="btnContractorPreviewClientQuote"/.test(ownerHtml) && /quote-contractor-preview\.js/.test(ownerHtml));
ok("seller has Preview client quote", /id="btnContractorPreviewClientQuote"/.test(salesHtml) && /quote-contractor-preview\.js/.test(salesHtml));
ok("owner send saves contractor preview", /MgContractorQuotePreview\.save/.test(appSrc));
ok("seller send saves contractor preview", /MgContractorQuotePreview\.save/.test(salesHtml));
ok("helper only opens estimate-public URLs", /estimate-public\\.html/.test(helperSrc));

console.log("\n" + passed + " passed");
