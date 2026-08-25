/**
 * Closed read-only contract lifecycle diagnostic for Support AI Stage 2F.
 * Exact project UUID only. Hub package/envelope overlay. GET only.
 * Never send raw rows, PII, money, tokens, legal body, or artifact payloads to OpenAI.
 *
 * Certificate/signed-PDF existence is omitted: production code has no proven
 * nested PostgREST relation under packages, and a third GET is not allowed.
 */
"use strict";

const { supabaseRequest } = require("../supabase-admin");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROJECT_CONTRACT_SELECT_FIELDS = ["id", "tenant_id"];
const PROJECT_CONTRACT_SELECT = PROJECT_CONTRACT_SELECT_FIELDS.join(",");

const PACKAGE_ENVELOPE_EMBED = "tenant_contract_envelopes(status,completed_at,created_at)";
const PACKAGE_DIAGNOSTIC_SELECT_FIELDS = ["id", "tenant_id", "project_id", "version", "status"];
const PACKAGE_DIAGNOSTIC_SELECT =
  PACKAGE_DIAGNOSTIC_SELECT_FIELDS.join(",") + "," + PACKAGE_ENVELOPE_EMBED;

const STATUS_LABELS = {
  fully_signed: "Fully Signed",
  waiting_for_signature: "Waiting for Customer Signature",
  secure_link_ready: "Secure Link Ready",
  signing_request_ready: "Signing Request Ready",
  frozen_ready: "Frozen Contract Ready",
  not_frozen: "Not Frozen",
};

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function isNonEmpty(value) {
  return String(value ?? "").trim() !== "";
}

function normStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isContractSqlOrListAllProbe(message) {
  const text = String(message || "").toLowerCase();
  return (
    /\blist all contracts\b/.test(text) ||
    /\bshow (me )?(every|all) contracts\b/.test(text) ||
    /\bevery contract\b/.test(text) ||
    /\bfrom tenant_contract_packages\b/.test(text) ||
    (/\brun sql\b/.test(text) && /\bcontracts?\b/.test(text))
  );
}

function isContractFinancialQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (!/\bcontracts?\b/.test(text)) return false;
  return (
    /\bcontract total\b/.test(text) ||
    /\bhow much is the contract\b/.test(text) ||
    /\bhow much is left\b/.test(text) ||
    /\bbalance\b/.test(text) ||
    /\bhow much\b/.test(text) && /\bdue\b/.test(text) ||
    /\bamount due\b/.test(text) ||
    /\bpayment schedule\b/.test(text) ||
    /\bnext (contract )?payment\b/.test(text) ||
    /\bwhat payment is due next\b/.test(text) ||
    /\bdeposit\b/.test(text)
  );
}

function isContractLegalQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (!/\bcontracts?\b/.test(text)) return false;
  return (
    /\bclause\b/.test(text) ||
    /\blegal notices?\b/.test(text) ||
    /\blegal terms\b/.test(text) ||
    /\bcontract terms\b/.test(text) ||
    /\bcancellation clause\b/.test(text) ||
    /\bwarranty (language|clause)\b/.test(text) ||
    /\bwhat does the contract say\b/.test(text)
  );
}

function extractContractProjectUuid(message) {
  const text = String(message || "").trim();
  if (!text) return null;
  const match = text.match(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i
  );
  if (!match) return null;
  const value = match[1];
  if (!isUuid(value)) return null;
  return { type: "id", value };
}

function isContractDiagnosticQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (!/\bcontracts?\b/.test(text)) return false;
  if (/\binvoices?\b/.test(text)) return false;
  if (/\b(quotes?|estimates?)\b/.test(text)) return false;
  if (isContractSqlOrListAllProbe(text)) return false;
  if (isContractFinancialQuestion(text)) return false;
  if (isContractLegalQuestion(text)) return false;
  if (/\bhow (do|can|to|does)\b/.test(text) && !extractContractProjectUuid(message)) {
    return false;
  }
  const hasUuid = Boolean(extractContractProjectUuid(message));
  const numberedBare = /\bcontracts?\s*#?\s*\d+\b/.test(text);
  return (
    hasUuid ||
    numberedBare ||
    /\b(status|signed|completed|frozen|certificate|pdf|prepared|waiting)\b/.test(text) ||
    /\bfully signed\b/.test(text) ||
    /\bsecure (signing )?link\b/.test(text) ||
    /\bwas contract\b/.test(text) ||
    /\bis contract\b/.test(text) ||
    /\bhas contract\b/.test(text)
  );
}

function unwrapEnvelopes(pkg) {
  let wrap = pkg?.tenant_contract_envelopes;
  if (Array.isArray(wrap)) return wrap;
  if (wrap && typeof wrap === "object") return [wrap];
  return [];
}

function orderEnvelopes(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) =>
    String(b?.created_at || "").localeCompare(String(a?.created_at || ""))
  );
}

/** Hub pickActivePackage, minus superseded/void fallback. */
function pickActivePackage(packages) {
  const list = Array.isArray(packages) ? packages : [];
  const ordered = [...list].sort((a, b) => Number(b?.version || 0) - Number(a?.version || 0));
  return (
    ordered.find((pkg) => {
      const st = normStatus(pkg?.status);
      return st === "ready" || st === "executed";
    }) || null
  );
}

/** Hub pickActiveEnvelope: completed > opened > sent > draft, else first in created_at desc. */
function pickActiveEnvelope(envelopes) {
  const list = orderEnvelopes(envelopes);
  const order = ["completed", "opened", "sent", "draft"];
  for (const st of order) {
    const hit = list.find((row) => normStatus(row?.status) === st);
    if (hit) return hit;
  }
  return list[0] || null;
}

function deriveContractStatus(pkg, envelope) {
  const pkgSt = normStatus(pkg?.status);
  const envSt = normStatus(envelope?.status);
  if (envSt === "completed" || pkgSt === "executed") return "fully_signed";
  if (pkg && envSt === "opened") return "waiting_for_signature";
  if (pkg && envSt === "sent") return "secure_link_ready";
  if (pkg && (pkgSt === "ready" || pkgSt === "executed") && envSt === "draft") {
    return "signing_request_ready";
  }
  if (pkg && (pkgSt === "ready" || pkgSt === "executed")) return "frozen_ready";
  return "not_frozen";
}

function toModelFacts({ projectUuid, pkg, envelope }) {
  const status = deriveContractStatus(pkg, envelope);
  const envSt = envelope ? normStatus(envelope.status) : "";
  const facts = {
    result: "found",
    project_ref: String(projectUuid || "").trim(),
    status,
    status_label: STATUS_LABELS[status] || STATUS_LABELS.not_frozen,
    package_frozen: Boolean(pkg),
    package_status: pkg ? normStatus(pkg.status) : null,
    envelope_status: envelope ? normStatus(envelope.status) : null,
    fully_signed: status === "fully_signed",
    secure_link_prepared: envSt === "sent" || envSt === "opened" || envSt === "completed",
    completed_at:
      envelope && isNonEmpty(envelope.completed_at) ? String(envelope.completed_at).trim() : null,
    delivery: {
      submitted_to_email_bridge: null,
      can_prove_recipient_received: false,
    },
  };
  return facts;
}

function buildProjectQueryPath(tenantId, projectUuid) {
  const tid = String(tenantId || "").trim();
  const pid = String(projectUuid || "").trim();
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tid}`);
  params.set("id", `eq.${pid}`);
  params.set("select", PROJECT_CONTRACT_SELECT);
  params.set("limit", "2");
  return `tenant_projects?${params.toString()}`;
}

function buildPackageQueryPath(tenantId, projectUuid) {
  const tid = String(tenantId || "").trim();
  const pid = String(projectUuid || "").trim();
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tid}`);
  params.set("project_id", `eq.${pid}`);
  params.set("select", PACKAGE_DIAGNOSTIC_SELECT);
  params.set("order", "version.desc");
  params.set("tenant_contract_envelopes.order", "created_at.desc");
  return `tenant_contract_packages?${params.toString()}`;
}

async function defaultContractGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

/**
 * @returns {Promise<{ outcome: "ok"|"not_found"|"status_unverified", facts?: object, queryPath: string, packageQueryPath?: string }>}
 */
async function readContractDiagnostic(tenantId, identifier, deps = {}) {
  const tid = String(tenantId || "").trim();
  const projectUuid = identifier && identifier.type === "id" ? String(identifier.value || "").trim() : "";
  if (!tid || !projectUuid || !isUuid(projectUuid)) {
    return { outcome: "not_found", queryPath: "" };
  }

  const queryPath = buildProjectQueryPath(tid, projectUuid);
  const get = deps.supabaseGet || defaultContractGet;
  let rows;
  try {
    rows = await get(queryPath);
  } catch (_err) {
    return { outcome: "status_unverified", queryPath };
  }
  if (!Array.isArray(rows)) {
    return { outcome: "status_unverified", queryPath };
  }

  const list = rows.filter((row) => String(row?.tenant_id || "").trim() === tid);
  if (list.length === 0) {
    return { outcome: "not_found", queryPath };
  }
  const project = list.find((row) => String(row?.id || "").trim() === projectUuid);
  if (!project) {
    return { outcome: "not_found", queryPath };
  }

  const packageQueryPath = buildPackageQueryPath(tid, projectUuid);
  let packages;
  try {
    packages = await get(packageQueryPath);
  } catch (_err) {
    return { outcome: "status_unverified", queryPath, packageQueryPath };
  }
  if (!Array.isArray(packages)) {
    return { outcome: "status_unverified", queryPath, packageQueryPath };
  }

  const owned = packages.filter(
    (row) =>
      String(row?.tenant_id || "").trim() === tid &&
      String(row?.project_id || "").trim() === projectUuid
  );
  const pkg = pickActivePackage(owned);
  const envelope = pkg ? pickActiveEnvelope(unwrapEnvelopes(pkg)) : null;

  return {
    outcome: "ok",
    facts: toModelFacts({ projectUuid, pkg, envelope }),
    queryPath,
    packageQueryPath,
  };
}

module.exports = {
  UUID_RE,
  PROJECT_CONTRACT_SELECT,
  PROJECT_CONTRACT_SELECT_FIELDS,
  PACKAGE_DIAGNOSTIC_SELECT,
  PACKAGE_DIAGNOSTIC_SELECT_FIELDS,
  PACKAGE_ENVELOPE_EMBED,
  STATUS_LABELS,
  extractContractProjectUuid,
  isContractDiagnosticQuestion,
  isContractFinancialQuestion,
  isContractLegalQuestion,
  isContractSqlOrListAllProbe,
  pickActivePackage,
  pickActiveEnvelope,
  deriveContractStatus,
  toModelFacts,
  buildProjectQueryPath,
  buildPackageQueryPath,
  readContractDiagnostic,
};
