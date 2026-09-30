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

function parseHubBilledWorkDate(line) {
  const text = String(line || "").trim();
  const m = text.match(/^[A-Za-z]{3}, ([A-Za-z]{3}) (\d{1,2}), (\d{4})$/);
  if (!m) return null;
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };
  if (!Object.prototype.hasOwnProperty.call(months, m[1])) return null;
  const d = new Date(Number(m[3]), months[m[1]], Number(m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatHubBilledQty(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return "";
  const rounded = Math.round(x * 100) / 100;
  return String(rounded);
}

function formatHubBilledDayList(dates) {
  const list = Array.isArray(dates) ? dates : [];
  const uniq = [];
  const seen = new Set();
  list.forEach((d) => {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return;
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (seen.has(t)) return;
    seen.add(t);
    uniq.push(new Date(t));
  });
  uniq.sort((a, b) => a.getTime() - b.getTime());
  if (!uniq.length) return "";
  const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const groups = [];
  let start = uniq[0];
  let end = uniq[0];
  for (let i = 1; i < uniq.length; i++) {
    const cur = uniq[i];
    const nextDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    if (cur.getTime() === nextDay.getTime()) {
      end = cur;
    } else {
      groups.push([start, end]);
      start = cur;
      end = cur;
    }
  }
  groups.push([start, end]);
  const sameYear = uniq.every((d) => d.getFullYear() === uniq[0].getFullYear());
  const fmtOne = (d, withMonth, withYear) => {
    const day = String(d.getDate());
    const mon = monthShort[d.getMonth()];
    if (withYear) return `${mon} ${day}, ${d.getFullYear()}`;
    if (withMonth) return `${mon} ${day}`;
    return day;
  };
  return groups
    .map((pair, idx) => {
      const a = pair[0];
      const b = pair[1];
      const prev = idx > 0 ? groups[idx - 1][1] : null;
      const needMonth = !prev || prev.getMonth() !== a.getMonth() || prev.getFullYear() !== a.getFullYear();
      if (a.getTime() === b.getTime()) return fmtOne(a, needMonth, !sameYear);
      const endNeedMonth = a.getMonth() !== b.getMonth() || a.getFullYear() !== b.getFullYear();
      return `${fmtOne(a, needMonth, false)}–${fmtOne(b, endNeedMonth, !sameYear && endNeedMonth)}`;
    })
    .join(", ");
}

function summarizeHubBilledWork(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const hours = { Pro: 0, Assistant: 0 };
  const dayQty = { Pro: 0, Assistant: 0 };
  const flats = { Pro: 0, Assistant: 0 };
  const dates = [];
  text.split("\n").forEach((line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    const date = parseHubBilledWorkDate(trimmed);
    if (date) {
      dates.push(date);
      return;
    }
    const worker = trimmed.match(/^- (Pro|Assistant):\s*([\d.]+)\s+(hours?|days?|flat)\b/i);
    if (worker) {
      const role = String(worker[1]).toLowerCase() === "assistant" ? "Assistant" : "Pro";
      const qty = Number(worker[2]);
      const unit = String(worker[3] || "").toLowerCase();
      if (!Number.isFinite(qty) || qty <= 0) return;
      if (unit.indexOf("hour") === 0) hours[role] += qty;
      else if (unit.indexOf("day") === 0) dayQty[role] += qty;
      else flats[role] += qty;
      return;
    }
    const legacy = trimmed.match(/^(?:Hourly|Daily|Flat) service — ([\d.]+) (hours?|days?|flat)\b/i);
    if (!legacy) return;
    const qty = Number(legacy[1]);
    const unit = String(legacy[2] || "").toLowerCase();
    if (!Number.isFinite(qty) || qty <= 0) return;
    if (unit.indexOf("hour") === 0) hours.Pro += qty;
    else if (unit.indexOf("day") === 0) dayQty.Pro += qty;
    else flats.Pro += qty;
  });
  const lines = [];
  const pushRole = (role) => {
    if (hours[role] > 0) {
      const n = formatHubBilledQty(hours[role]);
      lines.push(`${role}: ${n} ${Number(n) === 1 ? "hour" : "hours"}`);
    } else if (dayQty[role] > 0) {
      const n = formatHubBilledQty(dayQty[role]);
      lines.push(`${role}: ${n} ${Number(n) === 1 ? "day" : "days"}`);
    } else if (flats[role] > 0) {
      lines.push(`${role}: flat`);
    }
  };
  pushRole("Pro");
  pushRole("Assistant");
  const dayList = formatHubBilledDayList(dates);
  if (dayList) lines.push(`Days: ${dayList}`);
  return lines.join("\n") || text;
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
  ok("drawer Download PDF uses the send PDF builder", /async function hubDrawerDownloadPdf[\s\S]{0,1200}buildHubInvoicePdfForSend/.test(app));
  ok("drawer Download PDF saves a file", /function downloadGeneratedInvoicePdf[\s\S]{0,900}a\.download/.test(app));
  ok("drawer summarizes billed work", /function summarizeHubBilledWork\(raw\)/.test(app));
  ok("drawer render uses billed-work summary", /summarizeHubBilledWork\(parsed\.billedWork\)/.test(app));
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
  eq("billing-only summary is one role and compact days", summarizeHubBilledWork(billingOnly.billedWork), "Pro: 8 hours\nDays: Sep 28");

  const pepperCalendar = [
    "Hourly service",
    "Wed, Sep 16, 2026",
    "- Assistant: 6 hours at $85.60/hr",
    "Wed, Sep 23, 2026",
    "- Assistant: 4 hours at $85.60/hr",
    "Mon, Sep 28, 2026",
    "- Pro: 8 hours at $101.62/hr",
    "- Assistant: 8 hours at $85.60/hr",
    "Tue, Sep 29, 2026",
    "- Pro: 8 hours at $101.62/hr",
    "- Assistant: 8 hours at $85.60/hr",
    "Wed, Sep 30, 2026",
    "- Assistant: 8 hours at $85.60/hr",
  ].join("\n");
  eq(
    "consumer summary totals hours and compresses days",
    summarizeHubBilledWork(pepperCalendar),
    "Pro: 16 hours\nAssistant: 34 hours\nDays: Sep 16, 23, 28–30"
  );
  ok("consumer summary hides rates", !summarizeHubBilledWork(pepperCalendar).includes("$"));
  ok("consumer summary hides weekdays", !/Wed|Mon|Tue/.test(summarizeHubBilledWork(pepperCalendar)));

  eq(
    "legacy workers without days stay two lines",
    summarizeHubBilledWork("Hourly service\n- Pro: 66 hours at $131.38/hr\n- Assistant: 80 hours at $82.11/hr"),
    "Pro: 66 hours\nAssistant: 80 hours"
  );
  eq("one hour stays singular", summarizeHubBilledWork("- Pro: 1 hours at $101.62/hr"), "Pro: 1 hour");

  const withMarker = parseHubManualInvoiceNotes(
    "[source_invoice:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]\n\n" + sample
  );
  eq("parser strips source invoice marker", withMarker.description, parsed.description);

  const empty = parseHubManualInvoiceNotes("");
  eq("empty notes have no description", empty.description, "");
  eq("empty notes have no billed work", empty.billedWork, "");

  const publicHtml = read("public/invoice-public.html");
  const clientSrc = read("public/js/invoice-client-work-details.js");
  const clientApi = require("../public/js/invoice-client-work-details.js");
  ok("public invoice loads client work-details helper", publicHtml.includes('src="/js/invoice-client-work-details.js"'));
  ok("public invoice renders formatted work details", publicHtml.includes("formatClientFacingWorkDetails"));
  ok("public invoice still uses stored notes", publicHtml.includes("sanitizeClientFacingNotes"));
  ok("helper does not persist notes", !/supabase|fetch\(|PATCH/i.test(clientSrc));

  const pepperNotes = [
    "Service details:",
    "This service includes the installation of membrane and tile in designated areas and the custom cutting process for the fireplace to ensure a perfect fit.",
    "",
    "Billing:",
    pepperCalendar,
    "",
    "Labor subtotal: $4536.32",
    "",
    "Materials:",
    "membrane, two blades to take cutting the tile before taking it to the shop, 4 bags of thinset",
    "Materials subtotal: $512.00",
    "",
    "Invoice total: $5048.32",
  ].join("\n");
  const clientText = clientApi.formatClientFacingWorkDetails(pepperNotes);
  ok(
    "public work details keep the interpretation",
    clientText.includes("installation of membrane and tile")
  );
  ok("public work details show Pro hours", clientText.includes("Pro: 16 hours"));
  ok("public work details show Assistant hours", clientText.includes("Assistant: 34 hours"));
  ok("public work details compress days", clientText.includes("Days: Sep 16, 23, 28–30"));
  ok("public work details keep materials copy", clientText.includes("4 bags of thinset"));
  ok("public work details keep materials as copy not money", /^Materials$/m.test(clientText));
  ok("work details do not show materials amount", !/Materials: \$/.test(clientText));
  ok("work details do not show labor amount", !/Labor: \$/.test(clientText));
  eq("parser keeps materials amount for summary", clientApi.parseNotes(pepperNotes).materialsAmount, "$512.00");
  eq("parser keeps labor amount for summary", clientApi.parseNotes(pepperNotes).laborAmount, "$4536.32");
  ok("public invoice puts materials in summary totals", publicHtml.includes("breakdownSummaryRowsHtml"));
  ok("public invoice summary has Materials label", publicHtml.includes("<span>Materials</span>"));
  ok("public invoice summary rows have ledger dividers", /border-bottom:\s*1px solid #eceff3/.test(publicHtml));
  ok("public invoice remaining balance has a double rule", /border-top:\s*2px solid #111827/.test(publicHtml));
  ok("public work details use notebook lines", publicHtml.includes("repeating-linear-gradient"));
  ok("public work details hide hourly calendar", !/Hourly service/.test(clientText));
  ok("public work details hide hourly rates", !/\/hr/.test(clientText) && !/ at \$/.test(clientText));
  ok("public work details hide labor subtotal label", !/Labor subtotal/i.test(clientText));
  ok("public work details hide invoice total", !/Invoice total/i.test(clientText));
  ok("public work details hide materials subtotal label", !/Materials subtotal/i.test(clientText));

  const publicFn = read("netlify/functions/get-public-invoice.js");
  ok("public invoice header does not invent Service invoice", !/Service invoice/.test(publicHtml));
  ok("public invoice letterhead uses slogan from settings", publicHtml.includes("serviceLine") && publicHtml.includes("letterhead-lines"));
  ok("public invoice letterhead can show L#", /function formatLicenseLine/.test(publicHtml) && publicHtml.includes("L# "));
  ok("public invoice overlay loads service line from snapshot", /loadTenantServiceLineFromSnapshot/.test(publicFn));
  ok("public invoice overlay loads contractor L#", /tenant_legal_profiles/.test(publicFn) && /contractor_license_number/.test(publicFn));
  ok("public invoice does not invent license copy", !/1083733/.test(publicFn) && !/1083733/.test(publicHtml));
  ok("public invoice header does not print Manual Invoice", !/invoiceTitleBlock/.test(publicHtml));
  ok("public invoice letterhead overlay can use stored service area", /loadTenantLetterheadAddressFromSnapshot/.test(publicFn));
  ok("public invoice does not invent Prepared by", !/Prepared by/.test(publicHtml));
  ok("public invoice has View PDF button", publicHtml.includes("btnPublicInvoiceViewPdf") && publicHtml.includes("View PDF"));
  ok("public invoice has Download PDF button", publicHtml.includes("btnPublicInvoiceDownloadPdf") && publicHtml.includes("Download PDF"));
  ok("public invoice loads invoice pdf helper", publicHtml.includes("/js/invoice-pdf.js"));
  ok("public invoice loads jspdf", publicHtml.includes("jspdf@2.5.1"));
  ok("public invoice pdf does not invent license copy", !/1083733/.test(publicHtml));

  console.log("\n" + passed + " passed");
}

main();
