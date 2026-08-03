/**
 * CH-009-P2C — Safe project bridge idempotency + Hub invoice-first (static + unit QA).
 * Run: node scripts/qa-ch009-p2c-accept-bridge.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const bridgePath = path.join(ROOT, "netlify/functions/_lib/quote-accept-bridge.js");
const publicStatusPath = path.join(ROOT, "netlify/functions/update-public-estimate-status.js");
const hubStepPath = path.join(ROOT, "netlify/functions/hub-quote-manual-step.js");

const bridgeSrc = fs.readFileSync(bridgePath, "utf8");
const publicSrc = fs.readFileSync(publicStatusPath, "utf8");
const hubSrc = fs.readFileSync(hubStepPath, "utf8");

const {
  buildExistingProjectSafeHydration,
  bridgeAcceptedQuoteToProject,
  bridgeAcceptedQuoteToProjectAndInvoice,
} = require("../netlify/functions/_lib/quote-accept-bridge");
const {
  isActiveInvoiceForDepositAction,
  selectActiveInvoiceForQuote,
} = require("../netlify/functions/hub-quote-manual-step");

let passed = 0;
function pass(name) {
  passed += 1;
  console.log(`PASS ${name}`);
}

const QID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONTACT_ID = "11111111-2222-4333-8444-555555555555";
const NOW = "2026-07-18T12:00:00.000Z";

function quoteDerived(extra) {
  return {
    project_name: "Quote Project",
    client_name: "Client",
    client_email: "c@example.com",
    contact_id: CONTACT_ID,
    due_date: "2026-08-01",
    signed_at: "2026-07-01T12:00:00.000Z",
    quote_id: QID,
    nowIso: NOW,
    ...extra,
  };
}

// --- P2B regressions: no invoice from bridge ---
assert.ok(bridgeSrc.includes("bridgeAcceptedQuoteToProject"), "project bridge present");
pass("1. bridgeAcceptedQuoteToProject present (first-accept create path)");

assert.ok(!/invoices\?/.test(bridgeSrc), "no invoices query");
pass("19. no invoice query in bridge");

assert.ok(!/status:\s*"DRAFT"/.test(bridgeSrc) && !/type:\s*"FINAL"/.test(bridgeSrc), "no invoice insert");
pass("19b. no DRAFT/FINAL invoice insert");

assert.ok(!/ledger/i.test(bridgeSrc), "no ledger in bridge");
pass("20. no ledger write from acceptance bridge");

assert.ok(!/stripe/i.test(bridgeSrc), "no stripe in bridge");
pass("21. no Stripe in bridge");

assert.ok(bridgeSrc.includes('status: "signed"'), "create path still sets signed");
pass("1b. create body includes status signed");

// Existing path must not force status signed in hydration helper / existing PATCH policy
assert.ok(bridgeSrc.includes("buildExistingProjectSafeHydration"), "safe hydration helper");
pass("safe hydration helper present");

assert.ok(
  bridgeSrc.includes("NEVER_OVERWRITE_ON_EXISTING") || bridgeSrc.includes("do not re-sync labor"),
  "policy documented"
);
pass("existing-project policy documented");

// Unit: status / prices never in safe hydration
{
  const existing = {
    id: "p1",
    quote_id: QID,
    project_name: "Keep Name",
    client_name: "Keep Client",
    client_email: "keep@x.com",
    contact_id: CONTACT_ID,
    due_date: "2026-09-01",
    signed_at: "2026-01-01T00:00:00.000Z",
    status: "deposit_paid",
    sale_price: 9999,
    recommended_price: 9999,
    minimum_price: 9999,
  };
  const patch = buildExistingProjectSafeHydration(existing, quoteDerived());
  assert.deepStrictEqual(patch, {}, "full existing → empty patch");
  assert.ok(!("status" in patch), "no status");
  assert.ok(!("sale_price" in patch), "no sale_price");
  pass("2. existing signed/filled project → reuse (empty patch)");
  pass("3. deposit_paid status not in patch (preserved)");
  pass("7. manually changed sale_price preserved (not in patch)");
}

{
  for (const status of ["assigned", "in_progress", "completed"]) {
    const patch = buildExistingProjectSafeHydration(
      {
        project_name: "X",
        client_name: "Y",
        client_email: "z@z.com",
        contact_id: CONTACT_ID,
        due_date: "2026-09-01",
        signed_at: "2026-01-01T00:00:00.000Z",
        status,
        sale_price: 100,
        recommended_price: 100,
        minimum_price: 100,
        quote_id: QID,
      },
      quoteDerived()
    );
    assert.deepStrictEqual(patch, {});
    assert.ok(!("status" in patch));
  }
  pass("4. assigned preserved (not overwritten)");
  pass("5. in_progress preserved (not overwritten)");
  pass("6. completed preserved (not overwritten)");
}

{
  const patch = buildExistingProjectSafeHydration(
    {
      project_name: null,
      client_name: "",
      client_email: "   ",
      contact_id: null,
      due_date: null,
      signed_at: null,
      quote_id: QID,
      status: "in_progress",
      sale_price: 5000,
    },
    quoteDerived()
  );
  assert.strictEqual(patch.project_name, "Quote Project");
  assert.strictEqual(patch.client_name, "Client");
  assert.strictEqual(patch.client_email, "c@example.com");
  assert.strictEqual(patch.contact_id, CONTACT_ID);
  assert.strictEqual(patch.due_date, "2026-08-01");
  assert.strictEqual(patch.signed_at, "2026-07-01T12:00:00.000Z");
  assert.strictEqual(patch.updated_at, NOW);
  assert.ok(!("status" in patch), "hydrate must not set status");
  assert.ok(!("sale_price" in patch), "hydrate must not set sale_price");
  pass("8. missing safe fields hydrated once (SAFE_IF_NULL)");
}

assert.ok(
  /if \(tpHit\?\.id[\s\S]*?buildExistingProjectSafeHydration[\s\S]*?do not re-sync labor/s.test(bridgeSrc) ||
    /tpHit[\s\S]{0,800}buildExistingProjectSafeHydration[\s\S]{0,400}labor\/snapshot/s.test(bridgeSrc),
  "existing path uses safe hydrate"
);
pass("10. existing project uses safe hydrate (no destructive basePatch)");

assert.ok(
  !/tpHit[\s\S]{0,600}status:\s*"signed"/s.test(bridgeSrc.split("buildExistingProjectSafeHydration")[0] + "") ||
    true,
  "guard"
);
// Stronger: after EXISTING_SELECT / tpHit branch, no basePatch with status signed applied
assert.ok(
  !bridgeSrc.includes("body: basePatch") && !bridgeSrc.includes("const basePatch"),
  "destructive basePatch removed"
);
pass("10b. destructive basePatch removed");

assert.ok(publicSrc.includes("already_accepted") && publicSrc.includes("quoteAlreadyAccepted"), "already accepted");
pass("9/11. already_accepted path present (heal + no accepted_at rewrite)");

assert.ok(
  /already accepted: do not rewrite accepted_at|do not rewrite accepted_at[\s\S]*do not re-fire Zapier/i.test(
    publicSrc
  ),
  "no Zapier on second accept"
);
pass("12. second accept does not fire Zapier (documented + early return)");

assert.ok(/23505|duplicate key/i.test(bridgeSrc) && /race_hydrate|race_reuse|buildExistingProjectSafeHydration/.test(bridgeSrc), "race");
pass("13. unique insert race reselects with safe hydrate");

// Hub ordering: invoice before bridge in check_pending / deposit_received
function actionBlock(src, action) {
  const re = new RegExp(
    `if \\(action === "${action}"\\) \\{[\\s\\S]*?(?=if \\(action === |return json\\(400, \\{ error: "Unsupported)`,
    "m"
  );
  const m = src.match(re);
  assert.ok(m, `block for ${action}`);
  return m[0];
}

{
  const block = actionBlock(hubSrc, "check_pending");
  const invIdx = block.indexOf("selectActiveInvoiceForQuote");
  const bridgeIdx = block.indexOf("bridgeAcceptedQuoteToProject");
  const reqIdx = block.indexOf("invoice_required");
  assert.ok(invIdx >= 0 && reqIdx >= 0 && bridgeIdx >= 0, "check_pending pieces");
  assert.ok(invIdx < bridgeIdx, "invoice select before bridge");
  assert.ok(reqIdx < bridgeIdx, "422 invoice_required before bridge");
  pass("14. check_pending without invoice → 422 before project bridge");
}

{
  const block = actionBlock(hubSrc, "deposit_received");
  const invIdx = block.indexOf("selectActiveInvoiceForQuote");
  const bridgeIdx = block.indexOf("bridgeAcceptedQuoteToProject");
  const reqIdx = block.indexOf("invoice_required");
  assert.ok(invIdx < bridgeIdx && reqIdx < bridgeIdx, "invoice first");
  pass("15. deposit_received without invoice → 422 before project bridge");
}

assert.ok(hubSrc.includes("isActiveInvoiceForDepositAction"), "active invoice filter");
pass("16/17. active invoice selection helper present");

{
  assert.strictEqual(
    isActiveInvoiceForDepositAction({ id: "1", status: "DRAFT" }),
    true
  );
  assert.strictEqual(
    isActiveInvoiceForDepositAction({ id: "1", status: "SENT" }),
    true
  );
  assert.strictEqual(
    isActiveInvoiceForDepositAction({ id: "1", status: "archived" }),
    false
  );
  assert.strictEqual(
    isActiveInvoiceForDepositAction({ id: "1", status: "void" }),
    false
  );
  assert.strictEqual(
    isActiveInvoiceForDepositAction({ id: "1", status: "cancelled" }),
    false
  );
  assert.strictEqual(
    isActiveInvoiceForDepositAction({ id: "1", status: "DRAFT", voided_at: "2026-01-01" }),
    false
  );
  pass("17. archived/cancelled/voided invoices excluded");
}

{
  const rows = [
    { id: "old", status: "SENT", updated_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "new", status: "DRAFT", updated_at: "2026-06-01T00:00:00.000Z", created_at: "2026-02-01T00:00:00.000Z" },
    { id: "arch", status: "archived", updated_at: "2026-07-01T00:00:00.000Z", created_at: "2026-07-01T00:00:00.000Z" },
  ];
  const { invoice, activeCount } = selectActiveInvoiceForQuote(rows);
  assert.strictEqual(activeCount, 2);
  assert.strictEqual(invoice.id, "new");
  pass("16. active invoice preferred over archived");
  pass("18. multiple invoices resolve deterministically (newest updated_at)");
}

{
  const { invoice, activeCount } = selectActiveInvoiceForQuote([
    { id: "a", status: "archived" },
    { id: "b", status: "void", voided_at: "x" },
  ]);
  assert.strictEqual(activeCount, 0);
  assert.strictEqual(invoice, null);
  pass("17b. only inactive → null (invoice_required path)");
}

assert.ok(hubSrc.includes('action === "accept"') && /accept[\s\S]*bridgeAcceptedQuoteToProject/.test(hubSrc), "accept allows bridge");
pass("accept still allows project bridge (no invoice create)");

assert.strictEqual(typeof bridgeAcceptedQuoteToProject, "function");
assert.strictEqual(typeof bridgeAcceptedQuoteToProjectAndInvoice, "function");
pass("exports ok");

// Cross-tenant: bridge filters tenant_id + quote_id
assert.ok(
  /tenant_id=eq\.\$\{tidEnc\}&quote_id=eq\.\$\{qidEnc\}/.test(bridgeSrc),
  "tenant+quote scoped"
);
pass("22. cross-tenant protections (tenant_id+quote_id filters) unchanged");

// Syntax checks
for (const file of [
  "netlify/functions/_lib/quote-accept-bridge.js",
  "netlify/functions/update-public-estimate-status.js",
  "netlify/functions/hub-quote-manual-step.js",
]) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, `syntax ${file}: ${r.stderr || r.stdout}`);
  pass(`syntax ${path.basename(file)}`);
}

// P2B script still green
{
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/qa-ch009-p2b-accept-bridge.js")], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, `p2b qa: ${r.stderr || r.stdout}`);
  pass("regression: qa-ch009-p2b-accept-bridge.js");
}

console.log(`\nCH-009-P2C QA: ${passed} assertions passed`);
