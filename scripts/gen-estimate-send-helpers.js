const fs = require("fs");
const path = require("path");
const salesPath = path.join(__dirname, "../public/sales.html");
const outPath = path.join(__dirname, "../public/js/estimate-send-helpers.js");
const L = fs.readFileSync(salesPath, "utf8").split(/\r?\n/);

const head = `(function () {
  "use strict";
  function safeTrim(value) {
    return String(value == null ? "" : value).trim();
  }
  const INVALID_PUBLISH_BUSINESS_TOKENS = new Set([
    "gmail", "googlemail", "yahoo", "ymail", "outlook", "hotmail", "live", "msn",
    "icloud", "aol", "protonmail", "proton", "zoho", "fastmail", "gmx", "yandex", "hey"
  ]);
  function looksLikePublishEmail(value) {
    return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(value || "").trim());
  }
  function isInvalidPublishBusinessNameCandidate(value) {
    const t = safeTrim(value);
    if (!t) return true;
    if (/^business$/i.test(t)) return true;
    if (t.includes("@") || looksLikePublishEmail(t)) return true;
    if (INVALID_PUBLISH_BUSINESS_TOKENS.has(t.toLowerCase())) return true;
    return false;
  }
  function resolvePublishBusinessName(branding, payload, settings) {
    const b = branding && typeof branding === "object" ? branding : {};
    const p = payload && typeof payload === "object" ? payload : {};
    const s = settings && typeof settings === "object" ? settings : {};
    const candidates = [
      b.businessName, b.business_name, p.businessName, p.business_name,
      s.bizName, s.businessName, s.business_name, s.companyName, s.company_name
    ];
    for (const c of candidates) {
      if (!isInvalidPublishBusinessNameCandidate(c)) return safeTrim(c);
    }
    return "";
  }
  function hexToRgbTuple(value, fallback) {
    const clean = safeTrim(value).replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
  }
  function formatUsd(amount) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount || 0));
  }
`;

const pdf = L.slice(1128, 1850).join("\n");
const pick = L.slice(1851, 1860).join("\n");
const tenant = L.slice(1864, 2005).join("\n");

const tail = `
  window.__MG_ESTIMATE_SEND_HELPERS__ = {
    buildEstimatePdfPayload,
    buildEstimateTenantPayload,
    formatUsd,
    resolvePublishBusinessName,
    hexToRgbTuple,
    isInvalidPublishBusinessNameCandidate
  };
})();
`;

const out = head + "\n" + pdf + "\n" + pick + "\n" + tenant + "\n" + tail;
fs.writeFileSync(outPath, out, "utf8");
console.log("Wrote", outPath, out.length, "bytes");
