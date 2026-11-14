"use strict";

const { requireOwnerOrAdmin } = require("./_lib/require-owner-or-admin");
const { supabaseRequest } = require("./_lib/supabase-admin");
const portal = require("./_lib/homelink-portal");
const metricsApi = require("../../public/js/financial-command-metrics");

const EMPTY = {
  health: null,
  operating: null,
  profit: null,
  tax: null,
  savings: null
};

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function percentOrNull(value) {
  const n = finiteOrNull(value);
  if (n == null) return null;
  return Math.round(Math.max(0, Math.min(100, n)));
}

function buildHealth(input) {
  const src = input && typeof input === "object" ? input : {};
  const overhead = finiteOrNull(src.overheadMonthly);
  const months = finiteOrNull(src.savingsTargetMonths);
  const metrics = metricsApi.computeFinancialCommandMetrics({
    overheadMonthly: overhead,
    savingsTargetMonths: months,
    cashOnHand: finiteOrNull(src.cashOnHand),
    savingsBalance: finiteOrNull(src.savingsBalance),
    operatingBalance: finiteOrNull(src.operatingBalance),
    settingsLoaded: true,
    settingsError: false
  });
  let operating = null;
  let savings = null;
  if (overhead > 0) {
    const balance = finiteOrNull(src.operatingBalance);
    operating = percentOrNull(((balance == null ? 0 : balance) / overhead) * 100);
  }
  if (overhead > 0 && months > 0) {
    const balance = finiteOrNull(src.savingsBalance);
    savings = percentOrNull(((balance == null ? 0 : balance) / (overhead * months)) * 100);
  }
  const taxParts = [src.wcPct, src.ficaPct, src.futaPct, src.casuiPct].map(finiteOrNull);
  const taxKnown = taxParts.some(function (part) { return part != null; });
  const tax = taxKnown
    ? percentOrNull(taxParts.reduce(function (sum, part) { return sum + (part == null ? 0 : part); }, 0))
    : null;
  return {
    health: metrics.available ? Math.round(metrics.healthScore) : null,
    operating: operating,
    profit: percentOrNull(src.profitPct),
    tax: tax,
    savings: savings
  };
}

function asRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  if (data && typeof data === "object") return data;
  return null;
}

function settingsFromPayload(payload) {
  const storage = payload && payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  const settings = storage.mg_settings_v2 && typeof storage.mg_settings_v2 === "object"
    ? storage.mg_settings_v2
    : {};
  return {
    profitPct: finiteOrNull(settings.profitPct),
    wcPct: finiteOrNull(settings.wcPct),
    ficaPct: finiteOrNull(settings.ficaPct),
    futaPct: finiteOrNull(settings.futaPct),
    casuiPct: finiteOrNull(settings.casuiPct)
  };
}

function html(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY"
    },
    body: "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>HomeLink</title></head><body>" + body + "</body></html>"
  };
}

function returnPage(origin, health) {
  const packed = encodeURIComponent(JSON.stringify(health));
  const target = JSON.stringify(origin + "/#bh=" + packed);
  return html(200, "<p>Returning to HomeLink.</p><script>location.replace(" + target + ");</script>");
}

async function loadHealth(request, tenantId) {
  const tid = encodeURIComponent(tenantId);
  const owner = asRow(await request(
    "owner_settings?tenant_id=eq." + tid + "&select=overhead_monthly,savings_target_months&limit=1"
  ));
  let summary = null;
  try {
    summary = asRow(await request(
      "tenant_financial_summary?tenant_id=eq." + tid +
      "&currency=eq.USD&select=operating_balance,savings_balance,cash_on_hand&order=computed_at.desc&limit=1"
    ));
  } catch (_err) {
    summary = null;
  }
  let payload = null;
  try {
    const snap = asRow(await request(
      "tenant_snapshots?tenant_id=eq." + tid + "&select=payload&order=created_at.desc&limit=1"
    ));
    payload = snap && snap.payload ? snap.payload : null;
  } catch (_err2) {
    payload = null;
  }
  const rates = settingsFromPayload(payload);
  return buildHealth({
    overheadMonthly: owner ? owner.overhead_monthly : null,
    savingsTargetMonths: owner ? owner.savings_target_months : null,
    cashOnHand: summary ? summary.cash_on_hand : null,
    operatingBalance: summary ? summary.operating_balance : null,
    savingsBalance: summary ? summary.savings_balance : null,
    profitPct: rates.profitPct,
    wcPct: rates.wcPct,
    ficaPct: rates.ficaPct,
    futaPct: rates.futaPct,
    casuiPct: rates.casuiPct
  });
}

exports.buildHealth = buildHealth;
exports.EMPTY = EMPTY;

exports.handler = async function (event, deps) {
  const options = deps || {};
  const ownerGate = options.requireOwnerOrAdmin || requireOwnerOrAdmin;
  const request = options.supabaseRequest || supabaseRequest;
  const origin = portal.exactOrigin(options.homeOrigin || process.env.HOMELINK_ORIGIN);
  try {
    if (!event || event.httpMethod !== "GET") return html(405, "<p>method_not_allowed</p>");
    const query = event.queryStringParameters || {};
    if (Object.prototype.hasOwnProperty.call(query, "tenant_id")) return html(400, "<p>tenant_forbidden</p>");
    if (!origin) return html(503, "<p>handoff_not_configured</p>");
    let actor;
    try {
      actor = await ownerGate(event);
    } catch (err) {
      const code = err && err.code ? err.code : "no_session";
      if (code === "no_session") return returnPage(origin, EMPTY);
      return html(err && err.statusCode ? err.statusCode : 401, "<p>" + code + "</p>");
    }
    const tenantId = actor && actor.tenant && actor.tenant.id;
    if (!tenantId) return returnPage(origin, EMPTY);
    const health = await (options.loadHealth || loadHealth)(request, tenantId);
    return returnPage(origin, health);
  } catch (_err) {
    if (origin) return returnPage(origin, EMPTY);
    return html(500, "<p>server_error</p>");
  }
};
