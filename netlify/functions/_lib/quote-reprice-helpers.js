/**
 * Step 3E-C19-H — shared quote reprice helpers (owner/admin; no pricing formula changes).
 */

const { supabaseRequest } = require("./supabase-admin");
const { readSessionFromEvent } = require("./session");
const { resolveTenantFromSession } = require("./tenant-for-session");
const {
  membershipRole,
  membershipIsActive,
  resolveMembershipByEmail,
} = require("./membership-resolve");
const { throwGuard } = require("./tenant-device-guard");
const {
  calculateQuotePublishFinancials,
  sanitizeWorkersForTenantPricing,
} = require("./pricing-engine");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

const ALLOWED_REPRICE_BODY_KEYS = new Set([
  "quote_id",
  "workers",
  "pricing_stage",
  "price",
  "_manualPriceTouched",
  "manual_price_touched",
  "reason",
  "confirm_sent_update",
]);

const FORBIDDEN_WORKER_KEYS = new Set([
  "rate",
  "hourly_rate",
  "daily_rate",
  "price",
  "total",
  "cost",
  "estimated_cost",
  "labor_rate",
  "sell_rate",
  "margin",
  "profit",
  "overhead",
  "tax",
  "taxes",
  "commission",
  "offered_price",
  "minimum_price",
  "recommended_price",
]);

const REPRICE_QUOTE_SELECT = [
  "id",
  "tenant_id",
  "pricing_workers",
  "pricing_stage",
  "last_repriced_at",
  "last_repriced_by",
  "last_reprice_reason",
  "last_minimum_price",
  "last_recommended_price",
  "last_negotiation_price",
  "total",
  "deposit_required",
].join(",");

const REASON_MAX = 500;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function parseBody(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function findUnknownBodyKeys(body, allowedKeys = ALLOWED_REPRICE_BODY_KEYS) {
  const unknown = [];
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      unknown.push(key);
    }
  }
  return unknown.sort();
}

function extractSettingsFromSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const storage =
    payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  const mg =
    storage["mg_settings_v2"] && typeof storage["mg_settings_v2"] === "object"
      ? storage["mg_settings_v2"]
      : {};
  return mg;
}

async function loadTenantSettingsFromLatestSnapshot(tenantId) {
  const tid = encodeURIComponent(String(tenantId));
  const rows = await supabaseRequest(
    `tenant_snapshots?tenant_id=eq.${tid}&select=payload&order=created_at.desc&limit=1`,
    { method: "GET" }
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return extractSettingsFromSnapshotPayload(row?.payload);
}

/** Convert hours-only lines to fractional days (same as calc-secure-pricing). */
function normalizeWorkersLaborDays(workers, tenantSettings) {
  const list = Array.isArray(workers) ? workers : [];
  const hpd = Math.max(Number(tenantSettings?.hoursPerDay || 8), 0.25);
  return list.map((w) => {
    const obj = w && typeof w === "object" ? w : {};
    const d = Math.max(0, Number(obj.days || 0));
    const h = Math.max(0, Number(obj.hours || 0));
    const effectiveDays = d > 0 ? d : h > 0 ? h / hpd : 0;
    const out = {
      type: obj.type === "helper" ? "helper" : "installer",
      days: effectiveDays,
    };
    if (obj.name != null && String(obj.name).trim()) {
      out.name = String(obj.name).trim().slice(0, 120);
    }
    if (h > 0 && !(d > 0)) {
      out.hours = h;
    }
    return out;
  });
}

function workerHasForbiddenKeys(worker) {
  if (!worker || typeof worker !== "object") return false;
  for (const key of Object.keys(worker)) {
    if (FORBIDDEN_WORKER_KEYS.has(key)) return true;
  }
  return false;
}

function validateRepriceWorkers(rawWorkers) {
  if (!Array.isArray(rawWorkers) || rawWorkers.length === 0) {
    return { ok: false, code: "workers_required", error: "workers must be a non-empty array." };
  }

  for (const w of rawWorkers) {
    if (!w || typeof w !== "object" || Array.isArray(w)) {
      return { ok: false, code: "invalid_workers", error: "Each worker must be an object." };
    }
    if (workerHasForbiddenKeys(w)) {
      return {
        ok: false,
        code: "invalid_workers",
        error: "Worker lines cannot include rates or money overrides.",
      };
    }
    const type = String(w.type || "").trim().toLowerCase();
    if (type !== "helper" && type !== "installer") {
      return {
        ok: false,
        code: "invalid_workers",
        error: 'Each worker type must be "installer" or "helper".',
      };
    }
    const days = Math.max(0, Number(w.days || 0));
    const hours = Math.max(0, Number(w.hours || 0));
    if (!(days > 0 || hours > 0)) {
      return {
        ok: false,
        code: "invalid_workers",
        error: "Each worker needs days > 0 or hours > 0.",
      };
    }
  }

  return { ok: true };
}

function validateWorkersForPricing(workers) {
  if (!Array.isArray(workers) || workers.length === 0) {
    return {
      ok: false,
      code: "workers_required",
      error: "workers must be a non-empty array with labor lines.",
    };
  }
  let sumDays = 0;
  for (const w of workers) {
    sumDays += Math.max(0, Number(w?.days || 0));
  }
  if (!Number.isFinite(sumDays) || sumDays <= 0) {
    return {
      ok: false,
      code: "invalid_workers",
      error:
        "Each labor line needs days > 0 or hours > 0 (hours are converted using tenant hours per day).",
    };
  }
  return { ok: true };
}

function parsePricingStage(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, code: "invalid_pricing_stage", error: "pricing_stage is required (0, 1, or 2)." };
  }
  const stage = Number(raw);
  if (!Number.isFinite(stage) || ![0, 1, 2].includes(stage)) {
    return {
      ok: false,
      code: "invalid_pricing_stage",
      error: "pricing_stage must be 0 (minimum), 1 (negotiation), or 2 (recommended).",
    };
  }
  return { ok: true, stage };
}

function normalizeReason(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > REASON_MAX) {
    return { error: "reason_too_long", max: REASON_MAX };
  }
  return s;
}

function serializeRepriceState(row) {
  const r = row && typeof row === "object" ? row : {};
  return {
    pricing_workers: Array.isArray(r.pricing_workers) ? r.pricing_workers : null,
    pricing_stage:
      r.pricing_stage === null || r.pricing_stage === undefined
        ? null
        : Number(r.pricing_stage),
    last_repriced_at: r.last_repriced_at ?? null,
    last_reprice_reason: r.last_reprice_reason ?? null,
    last_minimum_price:
      r.last_minimum_price == null ? null : Number(r.last_minimum_price),
    last_negotiation_price:
      r.last_negotiation_price == null ? null : Number(r.last_negotiation_price),
    last_recommended_price:
      r.last_recommended_price == null ? null : Number(r.last_recommended_price),
  };
}

async function fetchQuoteRepriceRow(tenantId, quoteId) {
  const tid = encodeURIComponent(String(tenantId));
  const qid = encodeURIComponent(String(quoteId));
  const rows = await supabaseRequest(
    `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=${REPRICE_QUOTE_SELECT}&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function buildSettingsSnapshotForAudit(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const keys = [
    "hoursPerDay",
    "baseHelper",
    "baseInstaller",
    "wcPct",
    "ficaPct",
    "futaPct",
    "casuiPct",
    "stdHours",
    "overheadMonthly",
    "profitPct",
    "reservePct",
    "minimumMarginPct",
    "salesCommissionPct",
    "currency",
  ];
  const out = {};
  for (const key of keys) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  return out;
}

function buildEngineResultForAudit(financials) {
  const f = financials && typeof financials === "object" ? financials : {};
  return {
    total: f.total,
    deposit_required: f.deposit_required,
    minimum_price: f.minimum_price,
    recommended_price: f.recommended_price,
    negotiation: f.negotiation,
    labor: f.labor,
    before_profit: f.before_profit,
    reserve: f.reserve,
    totalHours: f.totalHours,
    totalWorkerDays: f.totalWorkerDays,
  };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function computeRepriceFinancials(workersSanitized, pricingStage, tenantSettings) {
  return calculateQuotePublishFinancials(
    {
      workers: workersSanitized,
      pricing_stage: pricingStage,
    },
    tenantSettings
  );
}

/** Owner manual final price override (Sales Admin); engine anchors unchanged. */
function parseManualRepriceInput(body) {
  const touched = Boolean(
    body?._manualPriceTouched ?? body?.manual_price_touched ?? body?.manualPriceTouched
  );
  const raw = body?.price;
  if (!touched || raw === undefined || raw === null || String(raw).trim() === "") {
    return { active: false };
  }
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      active: true,
      ok: false,
      code: "invalid_manual_price",
      error: "Manual final price must be a positive number.",
    };
  }
  return { active: true, ok: true, price: round2(price) };
}

function applyOwnerManualPrice(financials, manualPrice) {
  const min = Number(financials?.minimum_price);
  const price = round2(manualPrice);
  if (!Number.isFinite(min) || min <= 0) {
    return {
      ok: false,
      code: "pricing_engine_error",
      error: "Unable to resolve protected minimum price.",
    };
  }
  if (price + 1e-9 < min) {
    return {
      ok: false,
      code: "price_below_minimum",
      minimum_price: min,
      error: `Offered price cannot be below the minimum allowed (${min.toFixed(2)}).`,
    };
  }
  const total = price;
  const deposit_required = round2(Math.max(1000, total * 0.1));
  return {
    ok: true,
    financials: {
      ...financials,
      total,
      deposit_required,
    },
  };
}

async function requireOwnerOrAdmin(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e || !session?.c) {
    throwGuard(401, "Unauthorized", "no_session");
  }

  const tenant = await resolveTenantFromSession(session);
  if (!tenant?.id) {
    throwGuard(422, "Tenant not found for this session.", "tenant_not_found");
  }

  const membership = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
  if (!membership?.id) {
    throwGuard(403, "Membership not found", "membership_not_found");
  }
  if (!membershipIsActive(membership)) {
    throwGuard(403, "Membership is not active", "membership_inactive");
  }
  const role = membershipRole(membership);
  if (!OWNER_ADMIN_ROLES.has(role)) {
    throwGuard(403, "Owner or admin membership required", "owner_required");
  }

  return { tenant, membership };
}

module.exports = {
  ALLOWED_REPRICE_BODY_KEYS,
  REASON_MAX,
  json,
  pickFirst,
  parseBody,
  findUnknownBodyKeys,
  loadTenantSettingsFromLatestSnapshot,
  normalizeWorkersLaborDays,
  validateRepriceWorkers,
  validateWorkersForPricing,
  parsePricingStage,
  normalizeReason,
  serializeRepriceState,
  fetchQuoteRepriceRow,
  buildSettingsSnapshotForAudit,
  buildEngineResultForAudit,
  computeRepriceFinancials,
  parseManualRepriceInput,
  applyOwnerManualPrice,
  requireOwnerOrAdmin,
  sanitizeWorkersForTenantPricing,
};
