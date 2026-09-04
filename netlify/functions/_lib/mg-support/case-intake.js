/**
 * Closed support-case intake for MG-SUPPORT-003B.
 * Token mint/verify + duplicate GET + one fixed INSERT.
 * No OpenAI. No arbitrary tables/columns. GET/INSERT only.
 */
"use strict";

const crypto = require("crypto");
const { supabaseRequest } = require("../supabase-admin");

const TOKEN_TYPE = "mg_support_escalation_v1";
const TOKEN_VERSION = 1;
const ESCALATION_TTL_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 60;
const EXCERPT_MAX = 400;
const SUBJECT_MAX = 120;
const PAGE_MAX = 200;
const ENTITY_REF_MAX = 80;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CASE_TABLE = "tenant_support_cases";
const CASE_SELECT = "id,created_at";
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CATEGORIES = new Set([
  "unresolved_question",
  "diagnostic_unavailable",
  "possible_bug",
  "other",
]);
const MODULES = new Set([
  "invoice_hub",
  "quote",
  "project_control",
  "contract_hub",
  "documentation",
  "unknown",
]);
const ENTITY_TYPES = new Set(["invoice", "quote", "project", "contract", "none"]);

const PAGE_ALLOWLIST = new Set([
  "/",
  "/app",
  "/dashboard",
  "/estimates-invoices",
  "/invoice",
  "/owner",
  "/sales",
  "/seller",
  "/supervisor",
  "/project-control",
  "/sales-admin",
  "/signature-workspace",
  "/business-settings",
  "/legal-notices",
  "/contacts",
  "/team-devices",
  "/contract-hub",
  "/contract-builder",
  "/create-estimate",
]);

const MODULE_FROM_ROUTE = {
  "invoice-hub": "invoice_hub",
  "quote-builder": "quote",
  "project-control": "project_control",
  "contract-hub": "contract_hub",
  "sales-admin": "quote",
  dashboard: "documentation",
  "business-settings": "documentation",
};

function clip(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64url(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  return Buffer.from(padded, "base64").toString("utf8");
}

function getSessionSecret(deps = {}) {
  if (typeof deps.getSessionSecret === "function") {
    return String(deps.getSessionSecret() || "");
  }
  return String(process.env.SESSION_SECRET || "").trim();
}

function sanitizeExcerpt(raw) {
  let text = String(raw ?? "");
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
  text = text.replace(/\bbearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, "[redacted-token]");
  text = text.replace(/\b(sk|pk|rk|api)[-_]?[A-Za-z0-9]{16,}/gi, "[redacted-key]");
  text = text.replace(/\b(cookie|session|mg_session)\s*[:=]\s*\S+/gi, "[redacted-session]");
  text = text.replace(/\bauthorization\s*[:=]\s*.+$/gim, "[redacted-auth]");
  text = text.replace(/https?:\/\/[^\s]+/gi, "[redacted-url]");
  text = text.replace(/[\u0000-\u001F\u007F]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return clip(text, EXCERPT_MAX);
}

function normalizeIssueText(excerpt) {
  let text = String(excerpt ?? "");
  try {
    text = text.normalize("NFC");
  } catch (_err) {
    /* keep original */
  }
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

function fingerprintIssue(excerpt) {
  const normalized = normalizeIssueText(excerpt);
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

function sanitizePagePath(raw) {
  let path = String(raw ?? "").trim();
  if (!path) return null;
  try {
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      path = u.pathname || "";
    }
  } catch (_err) {
    /* keep path */
  }
  path = path.split("?")[0].split("#")[0];
  if (path.endsWith(".html")) path = path.slice(0, -5);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path.startsWith("/")) path = `/${path}`;
  path = clip(path, PAGE_MAX);
  if (PAGE_ALLOWLIST.has(path) || PAGE_ALLOWLIST.has(path.toLowerCase())) {
    return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
  }
  return null;
}

function mapModule(routed) {
  const list = Array.isArray(routed) ? routed : [];
  for (const row of list) {
    const id = String(row?.id || "").trim();
    if (MODULE_FROM_ROUTE[id]) return MODULE_FROM_ROUTE[id];
  }
  if (list.some((row) => String(row?.id || "") === "invoice-hub")) return "invoice_hub";
  if (list.length) return "documentation";
  return "unknown";
}

function deriveServerSubject(category, supportModule) {
  const cat = CATEGORIES.has(category) ? category : "other";
  const mod = MODULES.has(supportModule) ? supportModule : "unknown";
  let subject = "Support case";
  if (cat === "diagnostic_unavailable") {
    if (mod === "invoice_hub") subject = "Invoice status could not be verified";
    else if (mod === "project_control") subject = "Project status could not be verified";
    else if (mod === "contract_hub") subject = "Contract status could not be verified";
    else if (mod === "quote") subject = "Quote status could not be verified";
    else subject = "Status could not be verified";
  } else if (cat === "possible_bug") {
    subject = "Possible Margin Guard issue";
  } else if (cat === "unresolved_question") {
    subject = "Support question needs review";
  } else {
    subject = "Support case";
  }
  return clip(subject, SUBJECT_MAX);
}

function isPossibleBugReport(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  if (/\bdebug\b/.test(text) && !/\bbug\b/.test(text)) return false;
  return (
    /\bthis is a bug\b/.test(text) ||
    /\breport (a |this )?bug\b/.test(text) ||
    /\bpossible bug\b/.test(text) ||
    /\bapplication error\b/.test(text) ||
    /\bmargin guard (has a |is a )?bug\b/.test(text)
  );
}

function normalizeDetectorText(message) {
  let text = String(message || "");
  try {
    text = text.normalize("NFC");
  } catch (_err) {
    /* keep original */
  }
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isExplicitUnresolvedSupportRequest(message) {
  const text = normalizeDetectorText(message);
  if (!text) return false;
  return (
    /necesito soporte/.test(text) ||
    /necesito ayuda de soporte/.test(text) ||
    /el problema contin[uú]a/.test(text) ||
    /sigue sin funcionar/.test(text) ||
    /sigue sin poder/.test(text) ||
    /sigo sin funcionar/.test(text) ||
    /sigo sin poder/.test(text) ||
    /ya intent[eé] (eso|esto)/.test(text) ||
    /necesito que alguien lo revise/.test(text) ||
    /quiero abrir un caso/.test(text) ||
    /abrir un caso( de soporte)?/.test(text) ||
    /contact(ar)? (a )?soporte/.test(text) ||
    /\bcontact support\b/.test(text) ||
    /\bcreate (a )?support case\b/.test(text) ||
    /\bopen (a )?support case\b/.test(text) ||
    /\bescalate this\b/.test(text) ||
    /\bi need support\b/.test(text) ||
    /\bneed support because\b/.test(text) ||
    /\bstill not working\b/.test(text) ||
    /\bstill doesn't work\b/.test(text) ||
    /\bstill does not work\b/.test(text) ||
    /\bthe problem continues\b/.test(text) ||
    /\balready tried that\b/.test(text) ||
    /\bi need someone to (look at|review) (this|it)\b/.test(text)
  );
}

function explicitSupportCaseOfferAnswer(message) {
  const text = normalizeDetectorText(message);
  const spanish =
    /[áéíóúñ¿¡]/.test(text) ||
    /necesito|problema|funciona|soporte|caso|intent/.test(text);
  if (spanish) {
    return (
      "Entiendo. Como el problema continúa, puedo crear un caso de soporte para que sea revisado. ¿Quieres que lo cree?\n\n" +
      "Puedes incluir el número de factura antes de crear el caso, si lo tienes."
    );
  }
  return (
    "I understand. Since this is still unresolved, I can create a support case for review. Do you want me to create it?\n\n" +
    "You can optionally include the invoice number before creating the case."
  );
}

function clipEntityRef(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return clip(text, ENTITY_REF_MAX);
}

function bindRelatedEntity(intent, diagnostic, identifier) {
  if (!diagnostic || diagnostic.outcome !== "status_unverified") {
    return { type: "none", ref: null };
  }
  if (!identifier || !identifier.type || !identifier.value) {
    return { type: "none", ref: null };
  }
  const value = clipEntityRef(identifier.value);
  if (!value) return { type: "none", ref: null };

  if (intent === "invoice_diagnostic" && identifier.type === "invoice_no") {
    return { type: "invoice", ref: value };
  }
  if (
    (intent === "quote_diagnostic" || intent === "deposit_cta_diagnostic") &&
    identifier.type === "quote_number_display"
  ) {
    return { type: "quote", ref: value };
  }
  if (intent === "project_diagnostic" && identifier.type === "id" && isUuid(value)) {
    return { type: "project", ref: value.toLowerCase() };
  }
  if (intent === "contract_diagnostic" && identifier.type === "id" && isUuid(value)) {
    return { type: "contract", ref: value.toLowerCase() };
  }
  return { type: "none", ref: null };
}

function determineEscalationEligibility({ intent, diagnostic, message, hasOwnerTenant }) {
  if (!hasOwnerTenant) return null;
  const explicitSupport = isExplicitUnresolvedSupportRequest(message);
  if (!diagnostic) {
    if (isPossibleBugReport(message)) {
      return { category: "possible_bug" };
    }
    if (explicitSupport) {
      return { category: "unresolved_question" };
    }
    return null;
  }
  const outcome = diagnostic.outcome;
  if (outcome === "status_unverified") {
    return { category: "diagnostic_unavailable" };
  }
  if (explicitSupport) {
    return { category: "unresolved_question" };
  }
  if (outcome === "ok" || outcome === "found") return null;
  if (outcome === "needs_identifier") return null;
  if (outcome === "no_tenant_context") return null;
  if (outcome === "not_found") return null;
  if (outcome === "ambiguous") return null;
  if (isPossibleBugReport(message)) {
    return { category: "possible_bug" };
  }
  return null;
}

function formatCaseRef(id) {
  return `MG-SUP-${String(id || "").trim()}`;
}

function nowUnix(deps = {}) {
  if (typeof deps.nowSeconds === "function") return Number(deps.nowSeconds());
  return Math.floor(Date.now() / 1000);
}

function mintEscalationToken(fields, deps = {}) {
  const secret = getSessionSecret(deps);
  if (!secret) return null;
  const now = nowUnix(deps);
  const excerpt = sanitizeExcerpt(fields.questionExcerpt || fields.question_excerpt || "");
  const fingerprint = fingerprintIssue(excerpt);
  const entityType = ENTITY_TYPES.has(fields.related_entity_type)
    ? fields.related_entity_type
    : "none";
  const payload = {
    type: TOKEN_TYPE,
    version: TOKEN_VERSION,
    tenant_id: String(fields.tenant_id || "").trim(),
    category: fields.category,
    support_module: MODULES.has(fields.support_module) ? fields.support_module : "unknown",
    related_entity_type: entityType,
    related_entity_ref: entityType === "none" ? null : clipEntityRef(fields.related_entity_ref),
    page_path: sanitizePagePath(fields.page_path),
    question_excerpt: excerpt,
    issue_fingerprint: fingerprint,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + ESCALATION_TTL_SECONDS,
  };
  if (!isUuid(payload.tenant_id) || !CATEGORIES.has(payload.category) || !payload.nonce) {
    return null;
  }
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return {
    token: `${encodedPayload}.${signature}`,
    payload,
    expires_at: new Date(payload.exp * 1000).toISOString(),
  };
}

function verifyEscalationToken(token, trustedTenantId, deps = {}) {
  const secret = getSessionSecret(deps);
  if (!secret || !token || typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid_confirmation" };
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return { ok: false, reason: "invalid_confirmation" };

  const expected = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const sigA = Buffer.from(signature);
  const sigB = Buffer.from(expected);
  if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
    return { ok: false, reason: "invalid_confirmation" };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64url(encodedPayload));
  } catch (_err) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid_confirmation" };
  }

  const now = nowUnix(deps);
  if (payload.type !== TOKEN_TYPE) return { ok: false, reason: "invalid_confirmation" };
  if (payload.version !== TOKEN_VERSION) return { ok: false, reason: "invalid_confirmation" };
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (payload.iat > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: "invalid_confirmation" };
  if (payload.exp > payload.iat + ESCALATION_TTL_SECONDS + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (now > payload.exp) return { ok: false, reason: "invalid_confirmation" };
  if (!payload.nonce || typeof payload.nonce !== "string") {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (!isUuid(payload.tenant_id)) return { ok: false, reason: "invalid_confirmation" };
  if (String(payload.tenant_id) !== String(trustedTenantId || "").trim()) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (!CATEGORIES.has(payload.category)) return { ok: false, reason: "invalid_confirmation" };
  if (!MODULES.has(payload.support_module)) return { ok: false, reason: "invalid_confirmation" };
  if (!ENTITY_TYPES.has(payload.related_entity_type)) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (!FINGERPRINT_RE.test(String(payload.issue_fingerprint || ""))) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (String(payload.question_excerpt || "").length > EXCERPT_MAX) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (String(payload.nonce).length > 80) return { ok: false, reason: "invalid_confirmation" };
  if (payload.page_path != null && String(payload.page_path).length > PAGE_MAX) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (payload.exp < payload.iat) return { ok: false, reason: "invalid_confirmation" };
  const excerpt = sanitizeExcerpt(payload.question_excerpt);
  if (excerpt !== String(payload.question_excerpt || "")) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (fingerprintIssue(excerpt) !== String(payload.issue_fingerprint)) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  if (payload.related_entity_type === "none") {
    payload.related_entity_ref = null;
  } else if (!payload.related_entity_ref || String(payload.related_entity_ref).length > ENTITY_REF_MAX) {
    return { ok: false, reason: "invalid_confirmation" };
  }
  return { ok: true, payload };
}

function buildDuplicateQueryPath({ tenantId, category, entityType, entityRef, fingerprint, creatorId, sinceIso }) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("status", "eq.open");
  params.set("category", `eq.${category}`);
  params.set("related_entity_type", `eq.${entityType}`);
  params.set("issue_fingerprint", `eq.${fingerprint}`);
  params.set("created_at", `gte.${sinceIso}`);
  params.set("select", CASE_SELECT);
  params.set("order", "created_at.desc");
  params.set("limit", "1");
  if (entityRef) {
    params.set("related_entity_ref", `eq.${entityRef}`);
  } else {
    params.set("related_entity_ref", "is.null");
  }
  if (creatorId) {
    params.set("created_by_user_id", `eq.${creatorId}`);
  }
  return `${CASE_TABLE}?${params.toString()}`;
}

function buildIdempotencyQueryPath(tenantId, nonce) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("idempotency_key", `eq.${nonce}`);
  params.set("select", CASE_SELECT);
  params.set("limit", "1");
  return `${CASE_TABLE}?${params.toString()}`;
}

function isUniqueViolation(err) {
  const status = Number(err?.status);
  const msg = String(err?.message || "");
  const raw = String(err?.supabaseRaw || "");
  return status === 409 || /duplicate key|unique constraint|23505/i.test(msg + "\n" + raw);
}

function safeCaseResult(result, row) {
  const id = String(row?.id || "").trim();
  return {
    result,
    case_ref: formatCaseRef(id),
    case_id: id,
    status: "open",
  };
}

async function defaultCaseGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

async function defaultCaseInsert(row) {
  return supabaseRequest(CASE_TABLE, {
    method: "POST",
    body: row,
    headers: { Prefer: "return=representation" },
  });
}

/**
 * After HMAC + tenant checks. May GET then INSERT.
 */
async function intakeSupportCase({ payload, creatorId, deps = {} }) {
  const get = deps.supabaseGet || defaultCaseGet;
  const insert = deps.supabaseInsert || defaultCaseInsert;
  const tenantId = String(payload.tenant_id).trim();
  const creator = creatorId && isUuid(creatorId) ? String(creatorId).trim() : null;
  const sinceIso = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
  const dupPath = buildDuplicateQueryPath({
    tenantId,
    category: payload.category,
    entityType: payload.related_entity_type,
    entityRef: payload.related_entity_ref,
    fingerprint: payload.issue_fingerprint,
    creatorId: creator,
    sinceIso,
  });

  let existing;
  try {
    existing = await get(dupPath);
  } catch (_err) {
    return { http: 502, body: { ok: false, result: "write_failed", error: "I couldn't create that support case right now." } };
  }
  if (Array.isArray(existing) && existing[0]?.id) {
    return { http: 200, body: { ok: true, ...safeCaseResult("existing_case", existing[0]) }, queryPath: dupPath };
  }

  const row = {
    tenant_id: tenantId,
    created_by_user_id: creator,
    status: "open",
    category: payload.category,
    source: "support_chat",
    subject: deriveServerSubject(payload.category, payload.support_module),
    question_excerpt: sanitizeExcerpt(payload.question_excerpt),
    issue_fingerprint: payload.issue_fingerprint,
    page_path: payload.page_path || null,
    support_module: payload.support_module,
    related_entity_type: payload.related_entity_type,
    related_entity_ref: payload.related_entity_type === "none" ? null : payload.related_entity_ref,
    idempotency_key: String(payload.nonce).trim(),
  };

  try {
    const inserted = await insert(row);
    const created = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!created?.id) {
      return { http: 502, body: { ok: false, result: "write_failed", error: "I couldn't create that support case right now." } };
    }
    return { http: 200, body: { ok: true, ...safeCaseResult("created", created) }, queryPath: dupPath };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      return { http: 502, body: { ok: false, result: "write_failed", error: "I couldn't create that support case right now." } };
    }
    try {
      const replay = await get(buildIdempotencyQueryPath(tenantId, row.idempotency_key));
      const hit = Array.isArray(replay) && replay[0]?.id ? replay[0] : null;
      if (hit) {
        return { http: 200, body: { ok: true, ...safeCaseResult("existing_case", hit) }, queryPath: dupPath };
      }
    } catch (_err) {
      /* fall through */
    }
    return { http: 502, body: { ok: false, result: "write_failed", error: "I couldn't create that support case right now." } };
  }
}

module.exports = {
  TOKEN_TYPE,
  TOKEN_VERSION,
  ESCALATION_TTL_SECONDS,
  EXCERPT_MAX,
  SUBJECT_MAX,
  PAGE_MAX,
  ENTITY_REF_MAX,
  CASE_TABLE,
  CASE_SELECT,
  PAGE_ALLOWLIST,
  sanitizeExcerpt,
  normalizeIssueText,
  fingerprintIssue,
  sanitizePagePath,
  mapModule,
  deriveServerSubject,
  isPossibleBugReport,
  isExplicitUnresolvedSupportRequest,
  explicitSupportCaseOfferAnswer,
  bindRelatedEntity,
  determineEscalationEligibility,
  formatCaseRef,
  mintEscalationToken,
  verifyEscalationToken,
  buildDuplicateQueryPath,
  buildIdempotencyQueryPath,
  intakeSupportCase,
};
