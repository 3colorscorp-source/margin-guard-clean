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

const gcEmail = [
  "Thank you!",
  "Best regards,",
  "Roland",
  "Roland Zoller, General Contractor",
  "Roland Zoller Construction, CSLB #950926",
  "510-401-3609 mobile",
  "rolandzollerconstruction@gmail.com",
  "Specializing in residential renovations, remodeling, and repairs",
  "Member of the City of Fremont's Niles Main Street Association",
].join("\n");
eq("signature client name", lib.clientNameFromSignature(gcEmail), "Roland Zoller");
eq("signature phone", lib.enrichQuoteFieldsFromSource({}, gcEmail, gcEmail).client_phone.replace(/\D/g, "").slice(-10), "5104013609");
eq("signature email", lib.enrichQuoteFieldsFromSource({}, gcEmail, gcEmail).client_email, "rolandzollerconstruction@gmail.com");
ok("Fremont membership is not project address", !lib.enrichQuoteFieldsFromSource({}, gcEmail, gcEmail).project_address);

const gcFullEmail = [
  "Bid/Estimate For Dining Room Floor tile. 35978 Turpin Way Fremont Ca 94536",
  "",
  "Hello Librado",
  "",
  "We spoke on the phone a few weeks ago and you also sent me an email.",
  "Attached are floor plans for 1 of 2 projects I have in Fremont. The 2nd project I will send to you shortly.",
  "This project is for floor tile in the dining room. There is an existing tile currently. This will need to be demoed and prepped for a new tile. The room is set on a lower level slab foundation. (Rough area is 16ft x 14ft.",
  "Below is a link of the floor tile they have chosen. Clients will provide the tile and grout. All other materials by you. To include demo and tile installation",
  "I have also attached some pictures of the dining room area.",
  "",
  gcEmail,
].join("\n");
eq("email subject project name", lib.inferProjectNameFromEmail(gcFullEmail), "Dining Room Floor Tile");
ok("street address from subject", /35978 Turpin Way/i.test(lib.extractStreetAddress(gcFullEmail)));
ok("membership line is not a street", !lib.extractStreetAddress(gcEmail));
ok("pdf filename is not the client", lib.isPdfArtifactName("PDF Dining Room Tile", "PROPOSAL_PDF Dining Room Tile Area.pdf"));
eq("address-only paste flagged", client.isAddressOnlyPaste("rolandzollerconstruction@gmail.com"), true);
eq("full email is not address-only", client.isAddressOnlyPaste(gcFullEmail), false);

const fromFullEmail = lib.enrichQuoteFieldsFromSource(
  {
    project_name: "TILE INSTALLATION | DINING ROOM FLOOR",
    client_name: "PDF Dining Room Tile",
    client_email: "rolandzollerconstruction@gmail.com",
    client_phone: "",
    project_address: "",
  },
  "PROPOSAL_PDF Dining Room Tile Area.pdf\nPDF_TITLE Dining Room Tile Area\nCLIENT_EMAIL_BODY\n" + gcFullEmail,
  gcFullEmail
);
eq("full email overwrites pdf client name", fromFullEmail.client_name, "Roland Zoller");
eq("full email project name from subject", fromFullEmail.project_name, "Dining Room Floor Tile");
ok("full email fills Turpin address", /35978 Turpin Way/i.test(fromFullEmail.project_address) && /Fremont/i.test(fromFullEmail.project_address) && /94536/.test(fromFullEmail.project_address));
ok("full email fills phone", fromFullEmail.client_phone.replace(/\D/g, "").endsWith("5104013609"));
ok("full email dining area", fromFullEmail.areas.indexOf("Dining room") >= 0);
ok("full email 16ft x 14ft", /16\s*ft\s*x\s*14\s*ft/i.test(fromFullEmail.requirements));
ok("full email slab", /slab/i.test(fromFullEmail.requirements));
ok("full email client tile grout", /tile and grout/i.test(fromFullEmail.materials) || /tile and grout/i.test(fromFullEmail.exclusions));
ok("full email demo in scope", /demo/i.test(fromFullEmail.scope_of_work));
ok("Librado is not the client", fromFullEmail.client_name !== "Librado");
ok("client asks for full email paste", /subject, body, and signature/i.test(clientSrc));

if (fs.existsSync(demoPdf)) {
  const demolition = lib.extractPdfText(fs.readFileSync(demoPdf));
  const prepPdf = path.join("C:/Users/lalom/Downloads/Dining_Room_Preparation_Strata_Mat_View.pdf");
  const tilePdf = path.join("C:/Users/lalom/Downloads/Dining_Room_Tile_Installed_View (1).pdf");
  const pdfs = [
    { name: "Dining_Room_Demolition_View.pdf", title: demolition.title, text: demolition.text },
    fs.existsSync(prepPdf)
      ? Object.assign({ name: "Dining_Room_Preparation_Strata_Mat_View.pdf" }, lib.extractPdfText(fs.readFileSync(prepPdf)))
      : null,
    fs.existsSync(tilePdf)
      ? Object.assign({ name: "Dining_Room_Tile_Installed_View.pdf" }, lib.extractPdfText(fs.readFileSync(tilePdf)))
      : null,
  ].filter(Boolean);
  const source = lib.combineSourceText(gcEmail, pdfs);
  const filled = lib.enrichQuoteFieldsFromSource({}, source, gcEmail);
  eq("GC dining project name", filled.project_name, "Dining Room Tile Installation");
  eq("GC dining client name", filled.client_name, "Roland Zoller");
  eq("GC dining email", filled.client_email, "rolandzollerconstruction@gmail.com");
  ok("GC dining phone", filled.client_phone.replace(/\D/g, "").endsWith("5104013609") || filled.client_phone.indexOf("510") >= 0);
  ok("GC dining area", filled.areas.indexOf("Dining room") >= 0);
  ok("GC dining materials include Strata Mat", /STRATA/i.test(filled.materials));
  ok("GC dining mosaic", /Maverick/i.test(filled.materials));
  ok("GC dining scope has demolition and tile", /demolition/i.test(filled.scope_of_work) && /mosaic/i.test(filled.scope_of_work));
  ok("GC dining has exclusions", /excluded|written approval/i.test(filled.exclusions));
  const days = lib.enrichDaysFromSource({ days: [] }, source).days;
  ok("GC dining has three phases", days.length === 3);
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

  const gcInterpreted = await handlerCase(
    {
      resolveContext: async () => ({ auth_mode: "owner", tenant: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }),
      interpret: async () => ({
        summary: "Dining room tile",
        needs_review: [],
        quote_fields: {
          project_name: "TILE INSTALLATION | DINING ROOM FLOOR",
          client_name: "PDF Dining Room Tile",
          client_email: "rolandzollerconstruction@gmail.com",
          client_phone: "",
          project_address: "",
          areas: [],
          scope_of_work: "",
          requirements: "",
          materials: "",
          exclusions: "",
          important_dates: "",
        },
        document: { start_date: null, due_date: null, days: [] },
      }),
    },
    { httpMethod: "POST", body: JSON.stringify({ email_body: gcFullEmail }) }
  );
  eq("full email handler success", gcInterpreted.statusCode, 200);
  const gcBody = JSON.parse(gcInterpreted.body);
  eq("handler replaces pdf client name", gcBody.quote_fields.client_name, "Roland Zoller");
  eq("handler uses email subject project", gcBody.quote_fields.project_name, "Dining Room Floor Tile");
  ok("handler fills job address", /Turpin Way/i.test(gcBody.quote_fields.project_address));
  ok("handler fills signature phone", String(gcBody.quote_fields.client_phone).replace(/\D/g, "").endsWith("5104013609"));
  ok("handler keeps CSLB in requirements", /950926/.test(gcBody.quote_fields.requirements));
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
