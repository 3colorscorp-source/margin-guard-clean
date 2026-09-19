/**
 * CH-007D — Article 3 Property presentation (no Coming Soon; 3 address states).
 * Isolated static QA. Does not delete backend property columns.
 * Run: node scripts/qa-ch007d-article3-property-clean.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const htmlPath = path.join(ROOT, "public/contract-builder.html");
const jsPath = path.join(ROOT, "public/js/contract-builder.js");
const helperPath = path.join(ROOT, "public/js/contract-property-confirm.js");
const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const PropertyConfirm = require("../public/js/contract-property-confirm.js");

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

function slice(src, startToken, endToken) {
  const start = src.indexOf(startToken);
  const end = src.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `missing slice ${startToken}`);
  return src.slice(start, end);
}

const art3 = slice(html, 'id="art-property"', 'id="art-quote"');
const art1 = slice(html, 'id="art-contractor"', 'id="art-customer"');
const art2 = slice(html, 'id="art-customer"', 'id="art-property"');

test("0 syntax contract-builder.js", () => {
  const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
});

test("1 Coming Soon / optional details are gone from Article 3", () => {
  assert.ok(!art3.includes("cb-prop-secondary"));
  assert.ok(!/Coming soon/i.test(art3));
  assert.ok(!/Optional details/i.test(art3));
  assert.ok(!/Site notes/i.test(art3));
  assert.ok(!/Access notes/i.test(art3));
  assert.ok(!/GPS location/i.test(art3));
  assert.ok(!/Photos/i.test(art3));
  assert.ok(!html.includes("cb-prop-secondary"));
});

test("2 Article 3 keeps Project, Project Address, and confirmation status", () => {
  assert.ok(art3.includes("cb-prop-workspace__eyebrow"));
  assert.ok(art3.includes(">Project<"));
  assert.ok(art3.includes("id=\"cbProjectName\""));
  assert.ok(art3.includes("Project Address"));
  assert.ok(art3.includes("id=\"cbPropLine1\""));
  assert.ok(art3.includes("id=\"cbPropConfirmBadge\""));
  assert.ok(art3.includes("id=\"cbPropConfirmText\""));
});

test("3 missing vs unconfirmed vs confirmed copy is distinct", () => {
  assert.ok(js.includes('message: "Add the project address to continue."'));
  assert.ok(js.includes('"Confirm the project address to continue."'));
  assert.ok(js.includes('badgeText.textContent = "Add the project address to continue."'));
  assert.ok(js.includes('badgeText.textContent = "Confirm the project address to continue."'));
  assert.ok(js.includes('badgeText.textContent = "Property Address Confirmed"'));
  const addIdx = js.indexOf("Add the project address to continue.");
  const confirmIdx = js.indexOf("Confirm the project address to continue.");
  assert.ok(addIdx > 0 && confirmIdx > 0);
  assert.ok(js.includes("if (!present)"));
  assert.ok(js.includes("Needs confirmation"));
  assert.ok(!js.includes("Address looks complete — Save to confirm"));
});

test("4 CTAs follow empty / unconfirmed / confirmed", () => {
  assert.ok(js.includes('saveLabel: "Confirm Project Address"'));
  assert.ok(js.includes('"Add Project Address"'));
  assert.ok(js.includes('"Edit Project Address"'));
  assert.ok(js.includes('"Confirm Project Address"'));
  assert.ok(js.includes("cbWsConfirmProperty"));
  assert.ok(js.includes("function workspaceConfirmProperty"));
  assert.ok(js.includes("createPropertyConfirmRunner"));
  assert.ok(js.includes("continueVisible"));
  assert.ok(js.includes("!propertyPlan.continueVisible") || js.includes("propertyPlan && !propertyPlan.continueVisible"));
  assert.ok(!js.includes('saveLabel: "Confirm Property"'));
  assert.ok(!js.includes('editLabel: "Edit Property"'));
});

test("5 confirmation stays explicit; address is not auto-rewritten", () => {
  const helperSrc = fs.readFileSync(helperPath, "utf8");
  assert.ok(helperSrc.includes("confirm_property_address: true"));
  assert.ok(js.includes("function propertyConfigured"));
  assert.ok(js.includes("createPropertyConfirmRunner"));
  assert.ok(!/property_city:\s*\"CA\"/.test(js + helperSrc));
  assert.ok(!/property_postal_code:\s*\"00000\"/.test(js + helperSrc));
});

test("6 backend property setup API is still used", () => {
  assert.ok(js.includes("CONTRACT_SETUP_API"));
  assert.ok(js.includes("property_address_line1"));
  assert.ok(js.includes("property_address_line2"));
  assert.ok(js.includes("property_city"));
  assert.ok(js.includes("property_state"));
  assert.ok(js.includes("property_postal_code"));
  assert.ok(js.includes("id=\"cbPropEditLine1\"") || html.includes('id="cbPropEditLine1"'));
});

test("7 other articles are not rewritten", () => {
  assert.ok(art1.includes("Contractor Information"));
  assert.ok(art2.includes("Customer Information"));
  assert.ok(html.includes('id="art-quote"'));
  assert.ok(html.includes('id="art-payment"'));
  assert.ok(html.includes('id="art-schedule"'));
  assert.ok(html.includes('id="art-signatures"'));
  assert.ok(!art1.includes("Coming soon"));
});

test("8 Preview and Print still expand Article 3 without Coming Soon", () => {
  assert.ok(html.includes("is-preview"));
  assert.ok(html.includes("is-printing"));
  assert.ok(html.includes("id=\"cbPrintDraft\""));
  assert.ok(!/is-preview[\s\S]{0,200}Coming soon/i.test(html));
});

test("9 helper loads before builder and is required", () => {
  const helperIdx = html.indexOf("contract-property-confirm.js");
  const builderIdx = html.indexOf("contract-builder.js");
  assert.ok(helperIdx > 0 && builderIdx > helperIdx);
  const r = spawnSync(process.execPath, ["--check", helperPath], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.ok(js.includes("MarginGuardContractPropertyConfirm"));
});

const COMPLETE = {
  line1: "10 Pier Ave",
  line2: "",
  city: "Oakland",
  state: "CA",
  zip: "94607",
};

function session(opts) {
  const options = opts || {};
  const posts = [];
  let busy = false;
  let confirmed = options.confirmed === true;
  let fields = PropertyConfirm.cloneFields(options.fields || {});
  let applyCount = 0;
  const postJson =
    options.postJson ||
    (async function (url, body) {
      posts.push({ url, body });
      if (options.httpFail) {
        return { ok: false, status: 500, data: { ok: false, error: "server" } };
      }
      return {
        ok: true,
        status: 200,
        data: {
          ok: true,
          setup: {
            property_address_line1: body.property_address_line1,
            property_address_line2: body.property_address_line2,
            property_city: body.property_city,
            property_state: body.property_state,
            property_postal_code: body.property_postal_code,
          },
          readiness: { project_address: "confirmed" },
        },
      };
    });
  const runner = PropertyConfirm.createPropertyConfirmRunner({
    getBusy: () => busy,
    setBusy: (value) => {
      busy = Boolean(value);
    },
    isConfirmed: () => confirmed,
    getFields: () => fields,
    getExtraAddress: () => options.extraAddress || "",
    getSetup: () => options.setup || null,
    getIds: () => ({ projectId: "proj-1", quoteId: "quote-1" }),
    postJson,
    applySuccess: (data) => {
      applyCount += 1;
      confirmed = PropertyConfirm.propertyConfigured({ readiness: data.readiness });
      fields = PropertyConfirm.propertyFieldsFromSetup(data.setup);
    },
  });
  return {
    posts,
    get busy() {
      return busy;
    },
    get confirmed() {
      return confirmed;
    },
    get fields() {
      return fields;
    },
    get applyCount() {
      return applyCount;
    },
    plan() {
      return PropertyConfirm.propertyFooterPlan({
        configured: confirmed,
        fields,
        extraAddress: options.extraAddress || "",
        setup: options.setup || null,
        busy,
      });
    },
    confirm: () => runner.confirm(),
  };
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log("PASS", name);
    passed += 1;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    failed += 1;
  }
}

(async () => {
  await testAsync("A empty address: Add CTA, Continue hidden, no POST", async () => {
    const s = session({ fields: {} });
    const plan = s.plan();
    assert.strictEqual(plan.kind, "missing");
    assert.strictEqual(plan.primaryLabel, "Add Project Address");
    assert.strictEqual(plan.primaryEnabledCount, 1);
    assert.strictEqual(plan.continueVisible, false);
    assert.ok(!plan.buttons.some((b) => b.id === "continue"));
    const result = await s.confirm();
    assert.strictEqual(result.posted, false);
    assert.strictEqual(result.reason, "missing");
    assert.strictEqual(s.posts.length, 0);
    assert.strictEqual(s.confirmed, false);
    assert.strictEqual(s.busy, false);
  });

  await testAsync("B complete unconfirmed: one POST preserves address and confirms", async () => {
    const s = session({ fields: COMPLETE });
    const plan = s.plan();
    assert.strictEqual(plan.kind, "unconfirmed");
    assert.strictEqual(plan.primaryLabel, "Confirm Project Address");
    assert.strictEqual(plan.primaryEnabledCount, 1);
    assert.strictEqual(plan.continueVisible, false);
    assert.ok(plan.buttons.some((b) => b.id === "edit" && b.style === "ghost"));
    const shown = PropertyConfirm.displayedAddressLines(COMPLETE);
    assert.deepStrictEqual(shown, ["10 Pier Ave", "Oakland, CA 94607"]);
    const result = await s.confirm();
    assert.strictEqual(result.posted, true);
    assert.strictEqual(s.posts.length, 1);
    const body = s.posts[0].body;
    assert.strictEqual(body.property_address_line1, "10 Pier Ave");
    assert.strictEqual(body.property_address_line2, "");
    assert.strictEqual(body.property_city, "Oakland");
    assert.strictEqual(body.property_state, "CA");
    assert.strictEqual(body.property_postal_code, "94607");
    assert.strictEqual(body.confirm_property_address, true);
    assert.strictEqual(body.property_city, COMPLETE.city);
    assert.strictEqual(body.property_state, COMPLETE.state);
    assert.notStrictEqual(body.property_state, "California");
    assert.strictEqual(s.confirmed, true);
    assert.strictEqual(s.busy, false);
    const after = s.plan();
    assert.strictEqual(after.kind, "confirmed");
    assert.strictEqual(after.continueVisible, true);
    assert.strictEqual(after.continueEnabled, true);
    assert.strictEqual(after.primaryLabel, "Continue");
    assert.strictEqual(after.primaryEnabledCount, 1);
  });

  await testAsync("C incomplete address: opens edit, no POST", async () => {
    const s = session({ fields: { line1: "10 Pier Ave", city: "", state: "", zip: "" } });
    const plan = s.plan();
    assert.strictEqual(plan.kind, "incomplete");
    assert.strictEqual(plan.primaryLabel, "Confirm Project Address");
    const result = await s.confirm();
    assert.strictEqual(result.posted, false);
    assert.strictEqual(result.reason, "incomplete");
    assert.strictEqual(result.openEdit, true);
    assert.ok(result.missing.includes("City"));
    assert.ok(result.missing.includes("State"));
    assert.ok(result.missing.includes("ZIP Code"));
    assert.strictEqual(s.posts.length, 0);
    assert.strictEqual(s.confirmed, false);
    assert.strictEqual(s.busy, false);
  });

  await testAsync("D already confirmed: no POST, Continue enabled", async () => {
    const s = session({ fields: COMPLETE, confirmed: true });
    const plan = s.plan();
    assert.strictEqual(plan.kind, "confirmed");
    assert.strictEqual(plan.primaryLabel, "Continue");
    assert.strictEqual(plan.continueVisible, true);
    assert.ok(plan.buttons.some((b) => b.id === "edit" && b.style === "ghost"));
    const result = await s.confirm();
    assert.strictEqual(result.posted, false);
    assert.strictEqual(result.reason, "already_confirmed");
    assert.strictEqual(s.posts.length, 0);
    assert.strictEqual(s.confirmed, true);
    assert.strictEqual(s.busy, false);
  });

  await testAsync("E HTTP failure: not confirmed, address kept, retry works", async () => {
    let fail = true;
    const httpPosts = [];
    const s = session({
      fields: COMPLETE,
      postJson: async (url, body) => {
        httpPosts.push({ url, body });
        if (fail) return { ok: false, status: 500, data: { ok: false, error: "boom" } };
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            setup: {
              property_address_line1: body.property_address_line1,
              property_address_line2: body.property_address_line2,
              property_city: body.property_city,
              property_state: body.property_state,
              property_postal_code: body.property_postal_code,
            },
            readiness: { project_address: "confirmed" },
          },
        };
      },
    });
    const first = await s.confirm();
    assert.strictEqual(first.reason, "http");
    assert.strictEqual(first.posted, true);
    assert.strictEqual(s.confirmed, false);
    assert.strictEqual(s.busy, false);
    assert.strictEqual(s.fields.line1, "10 Pier Ave");
    assert.strictEqual(s.fields.city, "Oakland");
    assert.strictEqual(s.applyCount, 0);
    const plan = s.plan();
    assert.strictEqual(plan.continueVisible, false);
    assert.strictEqual(plan.primaryLabel, "Confirm Project Address");
    fail = false;
    const retry = await s.confirm();
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(httpPosts.length, 2);
    assert.strictEqual(s.confirmed, true);
    assert.strictEqual(s.busy, false);
  });

  await testAsync("F double click: at most one POST", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const httpPosts = [];
    const s = session({
      fields: COMPLETE,
      postJson: async (url, body) => {
        httpPosts.push({ url, body });
        await gate;
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            setup: {
              property_address_line1: body.property_address_line1,
              property_address_line2: body.property_address_line2,
              property_city: body.property_city,
              property_state: body.property_state,
              property_postal_code: body.property_postal_code,
            },
            readiness: { project_address: "confirmed" },
          },
        };
      },
    });
    const first = s.confirm();
    const second = s.confirm();
    const secondResult = await second;
    assert.strictEqual(secondResult.reason, "busy");
    assert.strictEqual(secondResult.posted, false);
    release();
    const firstResult = await first;
    assert.strictEqual(firstResult.ok, true);
    assert.strictEqual(httpPosts.length, 1);
    assert.strictEqual(s.confirmed, true);
    assert.strictEqual(s.busy, false);
    assert.strictEqual(s.applyCount, 1);
  });

  await testAsync("resolve fields does not invent city/state/zip", async () => {
    const resolved = PropertyConfirm.resolvePropertyFields({
      setup: { property_address_line1: "10 Pier Ave" },
      edits: {},
    });
    assert.strictEqual(resolved.line1, "10 Pier Ave");
    assert.strictEqual(resolved.city, "");
    assert.strictEqual(resolved.state, "");
    assert.strictEqual(resolved.zip, "");
  });

  console.log("");
  console.log("CH-007D Article 3 property clean:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
})();
