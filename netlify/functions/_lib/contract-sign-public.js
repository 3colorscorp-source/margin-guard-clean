/**
 * CH-011F — Public contract signing portal read (token-gated).
 * Validates signing token → returns frozen package snapshot + signer context.
 * Read-only. No signature capture. No mutations.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  hashRawToken,
  loadTokenByHash,
  evaluateTokenValidity,
  trimField,
} = require("./contract-signing-token");

const API_VERSION = "ch-011f-v1";

function deepCloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

/**
 * Strip internal ids that are not needed for rendering.
 * Keep frozen business/customer/project/property/scope/price/schedule/warranty/terms/legal.
 */
function publicSnapshot(snapshot) {
  const snap = deepCloneJson(snapshot);
  if (!snap || typeof snap !== "object") return {};

  // Never expose tenant id on public payload.
  if (snap.tenant) {
    delete snap.tenant;
  }
  if (snap.source_ids) {
    delete snap.source_ids.project_id;
    delete snap.source_ids.quote_id;
    delete snap.source_ids.setup_id;
    delete snap.source_ids.schedule_id;
    delete snap.source_ids.legal_profile_id;
  }
  if (snap.project && Object.prototype.hasOwnProperty.call(snap.project, "id")) {
    delete snap.project.id;
  }
  if (snap.quote && Object.prototype.hasOwnProperty.call(snap.quote, "id")) {
    delete snap.quote.id;
  }
  if (snap.payment_schedule?.schedule) {
    const sch = snap.payment_schedule.schedule;
    delete sch.tenant_id;
    delete sch.project_id;
    delete sch.quote_id;
    delete sch.id;
  }
  if (Array.isArray(snap.payment_schedule?.items)) {
    snap.payment_schedule.items = snap.payment_schedule.items.map((item) => {
      const row = { ...item };
      delete row.tenant_id;
      delete row.project_id;
      delete row.schedule_id;
      delete row.id;
      return row;
    });
  }
  if (snap.business_settings?.legal_profile) {
    const lp = snap.business_settings.legal_profile;
    delete lp.id;
    delete lp.tenant_id;
  }
  return snap;
}

async function loadSignerRow(tenantId, signerId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(signerId)}` +
      `&select=id,role,party_name,email,sign_order,auth_method,is_required,status,package_id,envelope_id` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadEnvelopeRow(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,package_id,status,expires_at,sent_at,completed_at,cancelled_at,declined_at` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadPackageRow(tenantId, packageId) {
  const rows = await supabaseRequest(
    `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(packageId)}` +
      `&select=id,version,status,snapshot_json,content_hash,created_at` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function gateEnvelopePackage(envelope, pkg) {
  const envStatus = trimField(envelope?.status).toLowerCase();
  if (envStatus === "cancelled") {
    return {
      ok: false,
      status: 409,
      code: "envelope_cancelled",
      error: "This contract is no longer available for signing",
    };
  }
  if (envStatus === "declined") {
    return {
      ok: false,
      status: 409,
      code: "envelope_declined",
      error: "This contract was declined",
    };
  }
  if (envStatus === "completed") {
    return {
      ok: false,
      status: 409,
      code: "envelope_completed",
      error: "This contract has already been completed",
    };
  }
  if (envStatus === "expired") {
    return {
      ok: false,
      status: 409,
      code: "envelope_expired",
      error: "This contract envelope has expired",
    };
  }
  if (envStatus === "draft") {
    return {
      ok: false,
      status: 409,
      code: "envelope_not_sent",
      error: "This contract is not available for signing",
    };
  }

  const pkgStatus = trimField(pkg?.status).toLowerCase();
  if (pkgStatus === "void") {
    return {
      ok: false,
      status: 409,
      code: "package_void",
      error: "This contract package is void",
    };
  }
  if (pkgStatus === "superseded") {
    return {
      ok: false,
      status: 409,
      code: "package_superseded",
      error: "This contract package has been superseded",
    };
  }

  return { ok: true };
}

/**
 * Public read by raw signing token.
 * Invalid/unknown tokens → generic invalid (no tenant leak).
 */
async function loadPublicContractByToken(rawToken) {
  const token = trimField(rawToken);
  if (!token) {
    return {
      ok: false,
      status: 400,
      code: "invalid_token",
      error: "A valid signing link is required",
    };
  }

  let row;
  try {
    row = await loadTokenByHash(hashRawToken(token));
  } catch (_err) {
    return {
      ok: false,
      status: 500,
      code: "token_lookup_failed",
      error: "Could not validate signing link",
    };
  }
  if (!row?.id) {
    return {
      ok: false,
      status: 404,
      code: "invalid_token",
      error: "This signing link is invalid or unavailable",
    };
  }

  const validity = evaluateTokenValidity(row);
  if (!validity.ok) {
    const code =
      validity.code === "revoked" ||
      validity.code === "consumed" ||
      validity.code === "expired"
        ? validity.code
        : "invalid_token";
    return {
      ok: false,
      status: 409,
      code,
      error:
        code === "revoked"
          ? "This signing link has been revoked"
          : code === "consumed"
            ? "This signing link has already been used"
            : code === "expired"
              ? "This signing link has expired"
              : "This signing link is invalid or unavailable",
    };
  }

  const tenantId = row.tenant_id;
  let signer;
  let envelope;
  let pkg;
  try {
    signer = await loadSignerRow(tenantId, row.signer_id);
    envelope = await loadEnvelopeRow(tenantId, row.envelope_id);
    const packageId = envelope?.package_id || signer?.package_id;
    pkg = packageId ? await loadPackageRow(tenantId, packageId) : null;
  } catch (_err) {
    return {
      ok: false,
      status: 500,
      code: "contract_load_failed",
      error: "Could not load contract for this signing link",
    };
  }

  if (!signer?.id || !envelope?.id || !pkg?.id) {
    return {
      ok: false,
      status: 404,
      code: "invalid_token",
      error: "This signing link is invalid or unavailable",
    };
  }

  const gate = gateEnvelopePackage(envelope, pkg);
  if (!gate.ok) return gate;

  let snapshotRaw = pkg.snapshot_json;
  if (typeof snapshotRaw === "string") {
    try {
      snapshotRaw = JSON.parse(snapshotRaw);
    } catch (_e) {
      snapshotRaw = {};
    }
  }
  if (!snapshotRaw || typeof snapshotRaw !== "object") {
    snapshotRaw = {};
  }

  let snapshot;
  try {
    snapshot = publicSnapshot(snapshotRaw);
  } catch (_err) {
    return {
      ok: false,
      status: 500,
      code: "snapshot_prepare_failed",
      error: "Could not prepare contract content",
    };
  }

  return {
    ok: true,
    contract: {
      package: {
        version: pkg.version,
        status: trimField(pkg.status),
        frozen_at: snapshot.frozen_at || pkg.created_at || null,
      },
      envelope: {
        status: trimField(envelope.status),
        expires_at: envelope.expires_at || null,
        sent_at: envelope.sent_at || null,
      },
      signer: {
        role: trimField(signer.role),
        party_name: trimField(signer.party_name),
        email: trimField(signer.email).toLowerCase(),
        sign_order: Number(signer.sign_order) || 1,
        status: trimField(signer.status) || "pending",
      },
      token: {
        status: trimField(row.status),
        expires_at: row.expires_at || null,
      },
      snapshot,
    },
  };
}

module.exports = {
  API_VERSION,
  loadPublicContractByToken,
  publicSnapshot,
  gateEnvelopePackage,
};
