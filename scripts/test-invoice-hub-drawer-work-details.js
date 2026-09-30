#!/usr/bin/env node
/**
 * Invoice Hub draft drawer — interpreted description + billed work.
 * Isolated: source + notes parser only. No live Netlify, email, or DB writes.
 * Run: node scripts/test-invoice-hub-drawer-work-details.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

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

const HUB_INVOICE_TYPE_UNEXPECTED_MATERIAL_RE = /\[invoice_type:unexpected_material_cost\]/i;
const HUB_SOURCE_INVOICE_MARKER_RE =
  /\[source_invoice:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\]/i;

function parseHubManualInvoiceNotes(raw) {
  const text = String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(HUB_SOURCE_INVOICE_MARKER_RE, "")
    .replace(HUB_INVOICE_TYPE_UNEXPECTED_MATERIAL_RE, "")
    .trim();
  if (!text) return { description: "", billedWork: "" };
  let description = "";
  let billedWork = "";
  const service = text.match(/^Service details:\n([\s\S]*?)(?=\n\nBilling:|\n\nMaterials:|\n\nInvoice total:|$)/);
  if (service) description = String(service[1] || "").trim();
  const billing = text.match(/(?:^|\n)Billing:\n([\s\S]*?)(?=\n\nLabor subtotal:|\n\nMaterials:|\n\nInvoice total:|$)/);
  if (billing) billedWork = String(billing[1] || "").trim();
  if (!description && !billedWork) description = text;
  return { description, billedWork };
}

function main() {
  const html = read("public/estimates-invoices.html");
  const app = read("public/js/app.js");
  const createSrc = read("netlify/functions/create-manual-invoice.js");

  ok("drawer has work details wrap", html.includes('id="hubDrawerWorkDetailsWrap"'));
  ok("drawer has description target", html.includes('id="hubDrawerWorkDescription"'));
  ok("drawer has billed work target", html.includes('id="hubDrawerWorkBilling"'));
  ok("work details sit after delivery email", html.indexOf("hubDrawerContactWrap") < html.indexOf("hubDrawerWorkDetailsWrap"));
  ok("app parses stored manual notes", /function parseHubManualInvoiceNotes\(raw\)/.test(app));
  ok("app extracts Service details", app.includes("Service details:\\n"));
  ok("app extracts Billing block", app.includes("Billing:\\n"));
  ok("app renders work details in the drawer", /function hubDrawerRenderWorkDetails\(row\)/.test(app));
  ok("drawer render calls work details", /hubDrawerRenderWorkDetails\(row\)/.test(app));
  ok("create response returns stored notes", /notes:\s*String\(finalInvoice\.notes/.test(createSrc));
  ok("create seed keeps notes", /notes:\s*invoice\.notes/.test(app));
  ok("hub row sync keeps notes", /row\.hubInvoiceNotes\s*=\s*srv\.hubInvoiceNotes/.test(app));
  ok("folder ledger hide list does not drop work details", !/hubDrawerLowerBodyIds[\s\S]{0,420}hubDrawerWorkDetailsWrap/.test(app));

  const sample = [
    "Service details:",
    "Install 208 sqf membrane at Pepper. Pro 8 hours and assistant 8 hours.",
    "",
    "Billing:",
    "Hourly service",
    "Mon, Sep 28, 2026",
    "- Pro: 8 hours at $156.01/hr",
    "- Assistant: 8 hours at $92.00/hr",
    "",
    "Labor subtotal: $1,984.08",
    "",
    "Materials:",
    "Membrane",
    "Materials subtotal: $496.00",
    "",
    "Invoice total: $2,480.08",
  ].join("\n");

  const parsed = parseHubManualInvoiceNotes(sample);
  eq(
    "parser keeps the interpreted description",
    parsed.description,
    "Install 208 sqf membrane at Pepper. Pro 8 hours and assistant 8 hours."
  );
  ok("parser keeps billed days", parsed.billedWork.includes("Mon, Sep 28, 2026"));
  ok("parser keeps billed hours", parsed.billedWork.includes("Pro: 8 hours"));
  ok("parser does not leak labor subtotal into billed work", !parsed.billedWork.includes("Labor subtotal"));

  const billingOnly = parseHubManualInvoiceNotes(
    [
      "Billing:",
      "Hourly service",
      "Mon, Sep 28, 2026",
      "- Pro: 8 hours at $156.01/hr",
      "",
      "Labor subtotal: $1,248.08",
      "",
      "Invoice total: $1,248.08",
    ].join("\n")
  );
  eq("billing-only notes have no description", billingOnly.description, "");
  ok("billing-only notes keep the day", billingOnly.billedWork.includes("Mon, Sep 28, 2026"));

  const withMarker = parseHubManualInvoiceNotes(
    "[source_invoice:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]\n\n" + sample
  );
  eq("parser strips source invoice marker", withMarker.description, parsed.description);

  const empty = parseHubManualInvoiceNotes("");
  eq("empty notes have no description", empty.description, "");
  eq("empty notes have no billed work", empty.billedWork, "");

  console.log("\n" + passed + " passed");
}

main();
