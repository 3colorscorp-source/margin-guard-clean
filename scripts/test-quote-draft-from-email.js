#!/usr/bin/env node
/**
 * Paste-email Project Quote draft. Isolated assertions.
 * Run: node scripts/test-quote-draft-from-email.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-quote-email-draft-test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mg-quote-email-draft-test-key";

const ROOT = path.resolve(__dirname, "..");
const lib = require("../netlify/functions/_lib/quote-draft-from-email");
const { createHandler, buildProposedDocument } = require("../netlify/functions/quote-draft-from-email");
const client = require("../public/js/quote-draft-from-email.js");

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

const libSrc = read("netlify/functions/_lib/quote-draft-from-email.js");
const fnSrc = read("netlify/functions/quote-draft-from-email.js");
const clientSrc = read("public/js/quote-draft-from-email.js");
const ownerHtml = read("public/owner.html");
const salesHtml = read("public/sales.html");
const toml = read("netlify.toml");
const sendSrc = read("netlify/functions/send-quote-zapier.js");
const appSrc = read("public/js/app.js");

checkSyntax("netlify/functions/_lib/quote-draft-from-email.js");
checkSyntax("netlify/functions/quote-draft-from-email.js");
checkSyntax("public/js/quote-draft-from-email.js");
ok("syntax ok", true);

ok("no new SQL migration", !fs.existsSync(path.join(ROOT, "SUPABASE_QUOTE_DRAFT_FROM_EMAIL.sql")));
ok("handler does not persist email", /email_stored:\s*false/.test(fnSrc) && /store:\s*false/.test(fnSrc));
ok("handler never sends quote", !/send-quote-zapier|publish-public-quote/.test(fnSrc));
ok("client never sends quote", !/send-quote-zapier|publish-public-quote/.test(clientSrc));
ok("client keeps draft status", /estimateStatus = "draft"/.test(clientSrc));
ok("client uses existing operational plan", /operational_plan/.test(clientSrc) && /ownerOperationalHoursOverride/.test(clientSrc));
ok(
  "no mailbox scan; PDFs are user-attached",
  !/gmail\.googleapis|accounts\.google|imap/i.test(clientSrc + fnSrc) &&
    /source_pdfs/.test(clientSrc) &&
    /does not send/.test(clientSrc)
);
ok("API key stays on backend", /OPENAI_API_KEY/.test(fnSrc) && !/OPENAI_API_KEY/.test(clientSrc));
ok("owner page loads helper", /quote-draft-from-email\.js/.test(ownerHtml));
ok("seller page loads helper", /quote-draft-from-email\.js/.test(salesHtml));
ok("timeout configured", /\[functions\."quote-draft-from-email"\][\s\S]*timeout = 30/.test(toml));
ok("send-quote-zapier untouched by this feature", !/quote-draft-from-email/.test(sendSrc));
ok("app.js calculator not forked", !/quote-draft-from-email/.test(appSrc));
ok("reuses voice operational plan document", /voice-operational-plan/.test(fnSrc));
ok("instructions forbid invented prices", /Never include prices/.test(lib.SYSTEM_INSTRUCTIONS));

const fields = lib.sanitizeQuoteFields({
  project_name: "Kitchen remodel",
  client_name: "Ada Lopez",
  client_email: "not-an-email",
  client_phone: "555",
  project_address: "12 Main St, Irvine, CA 92618",
  areas: ["Kitchen", "Kitchen"],
  scope_of_work: "Replace cabinets",
  price: 9999,
  offered_price: 12,
});
eq("invalid email dropped", fields.client_email, "");
eq("invalid phone dropped", fields.client_phone, "");
eq("duplicate areas collapsed", fields.areas.length, 1);
ok("price key stripped from fields", !Object.prototype.hasOwnProperty.call(fields, "price"));

const review = lib.ensureNeedsReview(fields, []);
ok("missing email marked needs review", review.some((item) => /email/i.test(item)));

const stripped = lib.stripFinancial({ quote_fields: { project_name: "A", price: 9, deposit: 1 }, rate: 40 });
ok("stripFinancial drops price keys", stripped.quote_fields && stripped.quote_fields.price == null && stripped.rate == null);

const email = "Please tile the kitchen. Two installers for 8 hours on day one.";
const omitted = lib.omitUnstatedCrew("Please tile the kitchen next month.", {
  days: [{ day_number: 1, client_scope: "Tile kitchen", worker_assignments: [{ worker_type: "pro", worker_count: 2, hours_per_worker: 8 }] }],
});
eq("unstated crew omitted", omitted.days[0].worker_assignments.length, 0);
const kept = lib.omitUnstatedCrew(email, {
  days: [{ day_number: 1, client_scope: "Tile kitchen", worker_assignments: [{ worker_type: "pro", worker_count: 2, hours_per_worker: 8 }] }],
});
eq("stated crew kept", kept.days[0].worker_assignments.length, 1);

const plan = lib.deriveOperationalPlan({
  days: [
    {
      day_number: 1,
      client_scope: "Tile kitchen",
      internal_tasks: [{ label: "Install tile" }],
      worker_assignments: [{ worker_type: "pro", worker_role: "Installer", worker_count: 2, hours_per_worker: 8 }],
    },
    {
      day_number: 2,
      client_scope: "Punch list",
      worker_assignments: [],
    },
  ],
});
eq("plan keeps stated crew day and empty-crew phase", plan.length, 2);
eq("plan expands worker count", plan[0].workers.length, 2);
eq("empty-crew day kept without invented hours", plan[1].workers.length, 0);

ok("email address alone is insufficient", lib.isInsufficientSource("rolandzollerconstruction@gmail.com"));
ok("client agrees email-only is insufficient", client.isInsufficientSource("rolandzollerconstruction@gmail.com"));

const demoPdf = path.join("C:/Users/lalom/Downloads/Dining_Room_Demolition_View.pdf");
if (fs.existsSync(demoPdf)) {
  const extracted = lib.extractPdfText(fs.readFileSync(demoPdf));
  ok("dining demolition pdf has dining room text", /dining room/i.test(extracted.text));
  ok("dining demolition pdf has 252 sq ft", /252/.test(extracted.text));
  ok("dining demolition pdf title", /DEMOLITION/i.test(extracted.title || extracted.text));
  const prepPdf = path.join("C:/Users/lalom/Downloads/Dining_Room_Preparation_Strata_Mat_View.pdf");
  const tilePdf = path.join("C:/Users/lalom/Downloads/Dining_Room_Tile_Installed_View (1).pdf");
  const combined = lib.combineSourceText("rolandzollerconstruction@gmail.com", [
    extracted,
    fs.existsSync(prepPdf) ? lib.extractPdfText(fs.readFileSync(prepPdf)) : { name: "prep.pdf", text: "" },
    fs.existsSync(tilePdf) ? lib.extractPdfText(fs.readFileSync(tilePdf)) : { name: "tile.pdf", text: "" },
  ].map((row, i) => ({
    name: ["Dining_Room_Demolition_View.pdf", "Dining_Room_Preparation_Strata_Mat_View.pdf", "Dining_Room_Tile_Installed_View.pdf"][i],
    title: row.title,
    text: row.text,
  })));
  ok("combined GC source is sufficient", !lib.isInsufficientSource(combined));
  ok("combined source keeps GC email", /rolandzollerconstruction@gmail.com/.test(combined));
  ok("combined source has strata mat", /STRATA_MAT/i.test(combined));
  ok("combined source has slate mosaic", /Maverick Textured Slate Mosaic/i.test(combined));
}

const storage = {
  data: {},
  getItem(key) {
    return this.data[key] || null;
  },
  setItem(key, value) {
    this.data[key] = String(value);
  },
};
storage.setItem("mg_owner_v2", JSON.stringify({ estimateStatus: "draft", projectName: "", workers: [{ name: "Pro 1", hours: 40 }] }));
const applied = client.applyToDraft(
  {
    quote_fields: {
      project_name: "Kitchen remodel",
      client_name: "Ada Lopez",
      client_email: "ada@example.com",
      client_phone: "949-555-0101",
      project_address: "12 Main St, Irvine, CA 92618",
      areas: ["Kitchen"],
      scope_of_work: "Replace cabinets",
    },
    quote_notes: "Replace cabinets",
    operational_plan: plan,
    proposed_document: { start_date: null, due_date: null, days: [] },
  },
  { workspace: "owner", localStorage: storage, document: null, window: { localStorage: storage } }
);
const saved = JSON.parse(storage.getItem("mg_owner_v2"));
eq("apply keeps draft", applied.estimateStatus, "draft");
eq("apply does not persist email", applied.persistedEmail, false);
eq("apply does not send", applied.sent, false);
eq("saved status draft", saved.estimateStatus, "draft");
eq("saved project name", saved.projectName, "Kitchen remodel");
eq("saved client email", saved.clientEmail, "ada@example.com");
ok("saved plan uses current operational_plan", Array.isArray(saved.operational_plan) && saved.operational_plan.length === 2);
ok("email body not stored", saved.email_body == null && saved.source_email == null);
ok("no offered price written", saved.offeredPrice == null || saved.offeredPrice === 0 || saved.offeredPrice === "");

storage.setItem("mg_owner_v2", JSON.stringify({ estimateStatus: "sent", projectName: "Locked" }));
let lockedError = "";
try {
  client.applyToDraft({ quote_fields: { project_name: "X" } }, { workspace: "owner", window: { localStorage: storage } });
} catch (err) {
  lockedError = String(err && err.message);
}
ok("sent quote cannot be silently overwritten", /already sent/i.test(lockedError));

async function handlerCase(deps, event) {
  const handler = createHandler(deps);
  return handler(event);
}

async function main() {
  const shortRes = await handlerCase(
    { resolveContext: async () => { throw new Error("should not auth"); } },
    { httpMethod: "POST", body: JSON.stringify({ email_body: "hi" }) }
  );
  eq("short email rejected before auth", shortRes.statusCode, 400);
  const emailOnly = await handlerCase(
    { resolveContext: async () => { throw new Error("should not auth"); } },
    { httpMethod: "POST", body: JSON.stringify({ email_body: "rolandzollerconstruction@gmail.com" }) }
  );
  eq("email-only paste rejected", emailOnly.statusCode, 400);
  eq("email-only code", JSON.parse(emailOnly.body).code, "insufficient_source");

  const tenantRes = await handlerCase(
    { resolveContext: async () => ({ tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }) },
    { httpMethod: "POST", body: JSON.stringify({ email_body: "Please tile the kitchen cabinets next week.", tenant_id: "nope" }) }
  );
  eq("tenant_id rejected", tenantRes.statusCode, 400);
  eq("tenant_id code", JSON.parse(tenantRes.body).code, "tenant_id_rejected");

  const unauth = await handlerCase(
    {
      resolveContext: async () => {
        const err = new Error("Device session required");
        err.statusCode = 401;
        err.code = "no_device_session";
        throw err;
      },
    },
    { httpMethod: "POST", body: JSON.stringify({ email_body: "Please tile the kitchen cabinets next week for two days." }) }
  );
  eq("unauthorized rejected", unauth.statusCode, 401);

  const interpreted = await handlerCase(
    {
      resolveContext: async () => ({ auth_mode: "owner", tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }),
      interpret: async () => ({
        summary: "Kitchen tile from email",
        needs_review: [],
        quote_fields: {
          project_name: "Kitchen tile",
          client_name: "Ada Lopez",
          client_email: "ada@example.com",
          client_phone: "949-555-0101",
          project_address: "12 Main St, Irvine, CA 92618",
          areas: ["Kitchen"],
          scope_of_work: "Install kitchen tile",
          requirements: "",
          materials: "Porcelain tile",
          exclusions: "",
          important_dates: "",
          price: 8800,
        },
        document: {
          start_date: null,
          due_date: "soon",
          days: [
            {
              day_number: 1,
              client_scope: "Install kitchen tile",
              internal_tasks: [{ label: "Install tile" }],
              worker_assignments: [{ worker_type: "pro", worker_role: "Installer", worker_count: 2, hours_per_worker: 8 }],
            },
          ],
        },
      }),
    },
    {
      httpMethod: "POST",
      body: JSON.stringify({
        email_body: "Hi, this is Ada Lopez, ada@example.com. Please install porcelain tile in the kitchen. Two installers for 8 hours on day one.",
      }),
    }
  );
  eq("interpret success", interpreted.statusCode, 200);
  const body = JSON.parse(interpreted.body);
  eq("proposal not persisted", body.persisted, false);
  eq("email not stored", body.email_stored, false);
  eq("draft status in response", body.draft_status, "draft");
  eq("extracted project name", body.quote_fields.project_name, "Kitchen tile");
  ok("model price stripped", body.quote_fields.price == null);
  eq("invalid due date dropped", body.proposed_document.due_date, null);
  ok("response omits original email", !JSON.stringify(body).includes("Hi, this is Ada Lopez"));
  ok("public scope omits worker assignments", !JSON.stringify(body.public_client_scope).includes("worker_assignments"));
  ok("operational plan ready for current calculator", Array.isArray(body.operational_plan) && body.operational_plan[0].workers.length === 2);

  const noCrewDoc = buildProposedDocument("Please remodel the bathroom when you can.", {
    start_date: "2026-01-01",
    due_date: null,
    days: [
      {
        day_number: 1,
        client_scope: "Remodel bathroom",
        internal_tasks: [{ label: "Remodel bathroom" }],
        worker_assignments: [{ worker_type: "pro", worker_role: "Installer", worker_count: 1, hours_per_worker: 8 }],
      },
    ],
  });
  eq("unstated date dropped", noCrewDoc.start_date, null);
  eq("unstated crew cleared on proposed document", noCrewDoc.days[0].worker_assignments.length, 0);

  const dated = buildProposedDocument("Start on 2026-01-15 if possible.", {
    start_date: "2026-01-15",
    due_date: null,
    days: [],
  });
  eq("ISO date kept when present in email", dated.start_date, "2026-01-15");

  ok("client endpoint is backend function", client.ENDPOINT === "/.netlify/functions/quote-draft-from-email");
  ok("generate uses credentials include", /credentials:\s*"include"/.test(clientSrc));

  console.log("\n" + passed + " passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
