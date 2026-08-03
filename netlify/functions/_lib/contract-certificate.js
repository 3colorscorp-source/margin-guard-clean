/**
 * CH-011H — Audit certificate helpers (create + list).
 * Immutable evidence freeze for completed envelopes. No PDF/email.
 */

"use strict";

const { supabaseRequest } = require("./supabase-admin");
const {
  canonicalize,
  canonicalJson,
  sha256Hex,
} = require("./contract-package");

const API_VERSION = "ch-011h-v1";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trimField(value) {
  return String(value ?? "").trim();
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

function unknownKeys(input, allowed) {
  return Object.keys(input || {}).filter((key) => !allowed.has(key));
}

function serializeCertificate(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    envelope_id: row.envelope_id,
    package_id: row.package_id,
    project_id: row.project_id,
    certificate_number: trimField(row.certificate_number),
    status: trimField(row.status) || "issued",
    certificate_json:
      row.certificate_json && typeof row.certificate_json === "object"
        ? row.certificate_json
        : {},
    content_hash: trimField(row.content_hash),
    issued_at: row.issued_at || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function loadEnvelope(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,tenant_id,package_id,project_id,quote_id,status,completed_at,sent_at,created_at,updated_at` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadPackage(tenantId, packageId) {
  const rows = await supabaseRequest(
    `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(packageId)}` +
      `&select=id,version,status,content_hash,executed_at,project_id,quote_id` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadSigners(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_signers?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,role,party_name,email,sign_order,status,is_required,signed_at` +
      `&order=sign_order.asc,created_at.asc,id.asc`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

async function loadSignatureEvents(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_signature_events?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,signer_id,signature_method,signed_at,ip_address,user_agent,signer_role,signer_party_name,package_version,consent_esign,created_at` +
      `&order=signed_at.asc,id.asc`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

async function loadCertificateByEnvelope(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_certificates?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=*` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Evidence payload used for deterministic hashing (no issued_at).
 */
function buildCertificateEvidence({
  envelope,
  pkg,
  signers,
  events,
}) {
  const eventsBySigner = new Map();
  for (const ev of events) {
    eventsBySigner.set(String(ev.signer_id), ev);
  }

  const signerSummaries = (signers || []).map((s) => {
    const ev = eventsBySigner.get(String(s.id));
    return {
      signer_id: s.id,
      role: trimField(s.role),
      party_name: trimField(s.party_name),
      email: trimField(s.email).toLowerCase(),
      sign_order: Number(s.sign_order) || 1,
      is_required: s.is_required !== false,
      status: trimField(s.status),
      signed_at: s.signed_at || ev?.signed_at || null,
      signature_method: ev ? trimField(ev.signature_method) : null,
      signature_event_id: ev?.id || null,
      ip_address: ev?.ip_address || null,
      user_agent: ev?.user_agent || null,
    };
  });

  return {
    schema: "ch-011h-v1",
    package: {
      id: pkg.id,
      version: Number(pkg.version) || 1,
      status: trimField(pkg.status),
      content_hash: trimField(pkg.content_hash),
      executed_at: pkg.executed_at || null,
    },
    envelope: {
      id: envelope.id,
      status: trimField(envelope.status),
      completed_at: envelope.completed_at || null,
      sent_at: envelope.sent_at || null,
    },
    project_id: envelope.project_id,
    quote_id: envelope.quote_id,
    signers: signerSummaries,
    signature_event_ids: (events || []).map((e) => e.id).sort(),
    envelope_completed_at: envelope.completed_at || null,
  };
}

function hashCertificateEvidence(evidence) {
  return sha256Hex(canonicalJson(evidence));
}

function certificateNumberFromHash(contentHash) {
  return `MG-CERT-${String(contentHash).slice(0, 16).toUpperCase()}`;
}

function wrapCertificateJson(evidence, { contentHash, issuedAt }) {
  return {
    ...evidence,
    issued_at: issuedAt,
    verification_hash: contentHash,
  };
}

async function createContractCertificate({
  tenantId,
  envelopeId,
  createdBy = null,
}) {
  const existing = await loadCertificateByEnvelope(tenantId, envelopeId);
  if (existing?.id) {
    return {
      ok: true,
      idempotent: true,
      certificate: serializeCertificate(existing),
    };
  }

  const envelope = await loadEnvelope(tenantId, envelopeId);
  if (!envelope?.id) {
    return {
      ok: false,
      status: 404,
      code: "not_found",
      error: "Envelope not found",
    };
  }

  if (trimField(envelope.status).toLowerCase() !== "completed") {
    return {
      ok: false,
      status: 422,
      code: "envelope_not_completed",
      error: "Envelope must be completed to issue a certificate",
      envelope_status: trimField(envelope.status),
    };
  }

  const pkg = await loadPackage(tenantId, envelope.package_id);
  if (!pkg?.id) {
    return {
      ok: false,
      status: 404,
      code: "package_missing",
      error: "Contract package not found",
    };
  }

  if (trimField(pkg.status).toLowerCase() !== "executed") {
    return {
      ok: false,
      status: 422,
      code: "package_not_executed",
      error: "Package must be executed to issue a certificate",
      package_status: trimField(pkg.status),
    };
  }

  const signers = await loadSigners(tenantId, envelopeId);
  const required = signers.filter((s) => s.is_required !== false);
  if (!required.length) {
    return {
      ok: false,
      status: 422,
      code: "no_required_signers",
      error: "No required signers on envelope",
    };
  }
  const unsigned = required.filter(
    (s) => trimField(s.status).toLowerCase() !== "signed"
  );
  if (unsigned.length) {
    return {
      ok: false,
      status: 422,
      code: "required_signers_incomplete",
      error: "All required signers must be signed",
    };
  }

  const events = await loadSignatureEvents(tenantId, envelopeId);
  if (!events.length) {
    return {
      ok: false,
      status: 422,
      code: "missing_signature_events",
      error: "Signature audit events are required",
    };
  }

  for (const s of required) {
    const hasEvent = events.some((e) => String(e.signer_id) === String(s.id));
    if (!hasEvent) {
      return {
        ok: false,
        status: 422,
        code: "missing_signature_events",
        error: "Signature audit event missing for a required signer",
        signer_id: s.id,
      };
    }
  }

  const evidence = buildCertificateEvidence({
    envelope,
    pkg,
    signers,
    events,
  });
  const contentHash = hashCertificateEvidence(evidence);
  const issuedAt = new Date().toISOString();
  const certificateJson = wrapCertificateJson(evidence, {
    contentHash,
    issuedAt,
  });
  const certificateNumber = certificateNumberFromHash(contentHash);

  let inserted = null;
  try {
    const rows = await supabaseRequest(`tenant_contract_certificates`, {
      method: "POST",
      body: {
        tenant_id: tenantId,
        envelope_id: envelope.id,
        package_id: pkg.id,
        project_id: envelope.project_id,
        certificate_number: certificateNumber,
        status: "issued",
        certificate_json: certificateJson,
        content_hash: contentHash,
        issued_at: issuedAt,
        created_by: createdBy || null,
      },
    });
    inserted = Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    const text = String(err?.message || err?.supabaseRaw || "");
    if (/duplicate|unique|23505/i.test(text)) {
      const raced = await loadCertificateByEnvelope(tenantId, envelopeId);
      if (raced?.id) {
        return {
          ok: true,
          idempotent: true,
          certificate: serializeCertificate(raced),
        };
      }
    }
    throw err;
  }

  if (!inserted?.id) {
    return {
      ok: false,
      status: 500,
      code: "insert_failed",
      error: "Could not create certificate",
    };
  }

  return {
    ok: true,
    idempotent: false,
    certificate: serializeCertificate(inserted),
  };
}

async function listCertificatesForEnvelope(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_certificates?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=*` +
      `&order=issued_at.desc`,
    { method: "GET" }
  );
  return (Array.isArray(rows) ? rows : []).map(serializeCertificate).filter(Boolean);
}

module.exports = {
  API_VERSION,
  validUuid,
  unknownKeys,
  trimField,
  serializeCertificate,
  buildCertificateEvidence,
  hashCertificateEvidence,
  certificateNumberFromHash,
  wrapCertificateJson,
  createContractCertificate,
  listCertificatesForEnvelope,
  canonicalize,
  canonicalJson,
  sha256Hex,
};
