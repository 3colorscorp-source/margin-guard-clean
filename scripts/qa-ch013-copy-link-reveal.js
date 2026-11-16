"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const fn = fs.readFileSync(
  path.join(ROOT, "netlify/functions/contract-invitation-copy-link.js"),
  "utf8"
);
const lib = fs.readFileSync(
  path.join(ROOT, "netlify/functions/_lib/contract-invitation-copy-link.js"),
  "utf8"
);
const js = fs.readFileSync(path.join(ROOT, "public/js/signature-workspace.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "public/signature-workspace.html"), "utf8");

function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
}

check(path.join(ROOT, "netlify/functions/contract-invitation-copy-link.js"));
check(path.join(ROOT, "netlify/functions/_lib/contract-invitation-copy-link.js"));
check(path.join(ROOT, "public/js/signature-workspace.js"));

assert.ok(fn.includes("requireOwnerOrAdmin"));
assert.ok(fn.includes("tenant_id is not accepted from client"));
assert.ok(fn.includes("signing_url"));
assert.ok(!fn.includes("signing_token"));
assert.ok(lib.includes("revealOwnerCopyLink"));
assert.ok(lib.includes("resendInvitation"));
assert.ok(lib.includes("deliverCopyLink"));
assert.ok(lib.includes("owner_copy_link_reveal"));
assert.ok(lib.includes('COPYABLE_ENVELOPE = new Set(["sent", "opened"])'));
assert.ok(lib.includes("previous_link_replaced: true"));
assert.ok(lib.includes("never reconstruct a raw token from hash"));
assert.ok(js.includes("COPY_LINK_API"));
assert.ok(js.includes("copySigningLinkForOwner"));
assert.ok(js.includes("vis3Copy.hidden = !envWaiting"));
assert.ok(js.includes("The previous email link no longer works."));
assert.ok(!/sessionStorage/.test(js));
assert.ok(!/localStorage\.setItem/.test(js));
assert.ok(html.includes('id="swVis3CopyLinkBtn"'));
assert.ok(html.includes("Copy this link to send it by text or another email"));

const copy = require(path.join(ROOT, "netlify/functions/contract-invitation-copy-link.js"));
assert.ok(copy._test.ALLOWED_BODY_KEYS.has("envelope_id"));
assert.ok(copy._test.ALLOWED_BODY_KEYS.has("signer_id"));
assert.ok(!copy._test.ALLOWED_BODY_KEYS.has("tenant_id"));
assert.ok(!copy._test.ALLOWED_BODY_KEYS.has("token"));

console.log("ok owner can copy a new signing link after refresh without reconstructing the old token");
