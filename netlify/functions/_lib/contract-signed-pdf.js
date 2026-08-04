/**
 * CH-011I — Signed contract PDF: generate, private store, artifact metadata.
 * Renders only from frozen package snapshot + completed envelope + signature
 * events + audit certificate. No email. No public bucket URLs.
 */
"use strict";

const crypto = require("crypto");
const { supabaseRequest, getSupabaseConfig } = require("./supabase-admin");
const {
  buildPdfDocument,
  sanitizeSvgPath,
  svgPathToPdfOps,
  escapePdfText,
} = require("./simple-pdf");

const API_VERSION = "ch-011i-v1";
const GENERATOR_VERSION = "ch-011i-pdf-v1";
const ARTIFACT_TYPE = "signed_pdf";
const MIME_TYPE = "application/pdf";
const STORAGE_BUCKET = "contract-signed-pdfs";
const SIGNED_URL_EXPIRES_SEC = 300;
const PUBLIC_DOWNLOAD_POLICY =
  "deferred_token_bound — public signer download not implemented in CH-011I; Owner/Admin short-lived signed URL only";

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

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function money(value, currency) {
  const n = Number(value);
  const cur = trimField(currency) || "USD";
  if (!Number.isFinite(n)) return `${cur} —`;
  return `${cur} ${n.toFixed(2)}`;
}

function line(text, opts = {}) {
  return { text: text == null ? "" : String(text), ...opts };
}

function heading(text) {
  return line(text, { fontSize: 13, bold: true, afterGap: 4 });
}

function subhead(text) {
  return line(text, { fontSize: 11, bold: true, afterGap: 2 });
}

function body(text) {
  return line(text, { fontSize: 10 });
}

function blank(n = 6) {
  return line("", { fontSize: 8, gap: n });
}

function buildStoragePath(tenantId, projectId, envelopeId) {
  return `contracts/${tenantId}/${projectId}/${envelopeId}/signed-contract.pdf`;
}

function serializeArtifact(row) {
  if (!row?.id) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    envelope_id: row.envelope_id,
    package_id: row.package_id,
    certificate_id: row.certificate_id,
    project_id: row.project_id,
    artifact_type: trimField(row.artifact_type) || ARTIFACT_TYPE,
    storage_ref: trimField(row.storage_ref),
    sha256: trimField(row.sha256),
    file_size: Number(row.file_size) || 0,
    mime_type: trimField(row.mime_type) || MIME_TYPE,
    generated_at: row.generated_at || null,
    generator_version: trimField(row.generator_version),
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function loadEnvelope(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_envelopes?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,tenant_id,package_id,project_id,quote_id,status,completed_at,sent_at,created_at` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadPackageFull(tenantId, packageId) {
  const rows = await supabaseRequest(
    `tenant_contract_packages?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&id=eq.${encodeURIComponent(packageId)}` +
      `&select=id,version,status,content_hash,snapshot_json,executed_at,project_id,quote_id` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadCertificate(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_certificates?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,certificate_number,content_hash,certificate_json,issued_at,status` +
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

async function loadSignatureEventsFull(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_signature_events?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&select=id,signer_id,signature_method,signature_json,signed_at,ip_address,user_agent,signer_role,signer_party_name,package_version,consent_esign,created_at` +
      `&order=signed_at.asc,id.asc`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

async function loadArtifactByEnvelope(tenantId, envelopeId) {
  const rows = await supabaseRequest(
    `tenant_contract_signed_artifacts?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&artifact_type=eq.${encodeURIComponent(ARTIFACT_TYPE)}` +
      `&select=*` +
      `&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function businessIdentityFromSnapshot(snap) {
  const lp = snap?.business_settings?.legal_profile || {};
  const brand = snap?.business_settings?.branding || {};
  const name =
    trimField(lp.legal_business_name) ||
    trimField(brand.business_name) ||
    "Contractor";
  const lines = [name];
  if (trimField(lp.dba_name)) lines.push(`DBA: ${trimField(lp.dba_name)}`);
  const addr = [
    trimField(lp.business_address_line1),
    trimField(lp.business_address_line2),
    [trimField(lp.business_city), trimField(lp.business_state), trimField(lp.business_postal_code)]
      .filter(Boolean)
      .join(", "),
  ]
    .filter(Boolean)
    .join(", ");
  if (addr) lines.push(addr);
  else if (trimField(brand.business_address)) lines.push(trimField(brand.business_address));
  const phone = trimField(lp.business_phone) || trimField(brand.business_phone);
  const email = trimField(lp.business_email) || trimField(brand.business_email);
  if (phone) lines.push(`Phone: ${phone}`);
  if (email) lines.push(`Email: ${email}`);
  if (trimField(lp.contractor_license_number)) {
    lines.push(`License: ${trimField(lp.contractor_license_number)}`);
  }
  return lines;
}

function propertyLine(snap) {
  const p = snap?.property || {};
  return [
    trimField(p.address_line1),
    trimField(p.address_line2),
    [trimField(p.city), trimField(p.state), trimField(p.postal_code)]
      .filter(Boolean)
      .join(", "),
  ]
    .filter(Boolean)
    .join(", ");
}

function noticeEntries(snap) {
  const notices = snap?.legal_notices?.notices;
  if (!notices || typeof notices !== "object") return [];
  return Object.keys(notices)
    .sort()
    .map((key) => {
      const val = notices[key];
      if (typeof val === "string") return { key, text: val };
      if (val && typeof val === "object") {
        return {
          key,
          text: trimField(val.text || val.body || val.content || JSON.stringify(val)),
        };
      }
      return { key, text: String(val ?? "") };
    })
    .filter((n) => n.text);
}

function extractDrawnPath(signatureJson) {
  if (!signatureJson || typeof signatureJson !== "object") return "";
  if (signatureJson.svg_path) return sanitizeSvgPath(signatureJson.svg_path);
  if (Array.isArray(signatureJson.paths)) {
    return signatureJson.paths
      .map((p) => {
        if (typeof p === "string") return sanitizeSvgPath(p);
        if (p && typeof p === "object" && p.d) return sanitizeSvgPath(p.d);
        if (p && typeof p === "object" && Array.isArray(p.points)) {
          const pts = p.points;
          if (!pts.length) return "";
          let d = `M ${Number(pts[0].x) || 0} ${Number(pts[0].y) || 0}`;
          for (let i = 1; i < pts.length; i += 1) {
            d += ` L ${Number(pts[i].x) || 0} ${Number(pts[i].y) || 0}`;
          }
          return sanitizeSvgPath(d);
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (signatureJson.vectors && typeof signatureJson.vectors === "object") {
    const v = signatureJson.vectors;
    if (typeof v.d === "string") return sanitizeSvgPath(v.d);
    if (typeof v.svg_path === "string") return sanitizeSvgPath(v.svg_path);
    if (Array.isArray(v.paths)) {
      return extractDrawnPath({ paths: v.paths });
    }
  }
  return "";
}

/**
 * Build PDF line model from frozen sources only.
 */
function buildSignedContractLines({
  snap,
  pkg,
  envelope,
  certificate,
  signers,
  events,
  generatedAt,
}) {
  const lines = [];
  const biz = businessIdentityFromSnapshot(snap);
  const title =
    trimField(snap?.quote?.title) ||
    trimField(snap?.project?.name) ||
    "Signed Construction Contract";
  const currency =
    trimField(snap?.price?.currency) ||
    trimField(snap?.quote?.currency) ||
    "USD";

  lines.push(line("SIGNED CONTRACT", { fontSize: 16, bold: true, afterGap: 6 }));
  lines.push(body(title));
  lines.push(
    body(
      `Package version ${Number(pkg.version) || 1}  |  Package hash ${trimField(pkg.content_hash).slice(0, 16)}…`
    )
  );
  lines.push(blank(8));

  lines.push(heading("Business"));
  for (const b of biz) lines.push(body(b));
  lines.push(blank(6));

  lines.push(heading("Customer / Project / Property"));
  lines.push(
    body(
      `Customer: ${trimField(snap?.customer?.name) || "—"}` +
        (trimField(snap?.customer?.email)
          ? ` <${trimField(snap.customer.email)}>`
          : "")
    )
  );
  if (trimField(snap?.customer?.phone)) {
    lines.push(body(`Phone: ${trimField(snap.customer.phone)}`));
  }
  lines.push(
    body(
      `Project: ${trimField(snap?.project?.name) || "—"} (${trimField(snap?.project?.id) || envelope.project_id})`
    )
  );
  lines.push(body(`Property: ${propertyLine(snap) || "—"}`));
  lines.push(blank(6));

  lines.push(heading("SCOPE OF WORK"));
  lines.push(body(trimField(snap?.scope?.text) || "—"));
  lines.push(blank(6));

  lines.push(heading("Price"));
  lines.push(
    body(
      `Contract total: ${money(snap?.price?.contract_total ?? snap?.quote?.total, currency)}`
    )
  );
  if (snap?.price?.deposit_required != null || snap?.quote?.deposit_required != null) {
    lines.push(
      body(
        `Deposit required: ${money(
          snap?.price?.deposit_required ?? snap?.quote?.deposit_required,
          currency
        )}`
      )
    );
  }
  lines.push(blank(6));

  lines.push(heading("Estimated Schedule"));
  const estStart =
    trimField(snap?.contract_schedule?.estimated_start_date) ||
    trimField(snap?.quote?.start_date) ||
    "";
  const estDue =
    trimField(snap?.contract_schedule?.estimated_completion_date) ||
    trimField(snap?.quote?.due_date) ||
    "";
  function fmtContractDate(ymd) {
    const s = String(ymd || "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "—";
    // Display-only; keep calendar day (noon local).
    return s;
  }
  lines.push(body(`Estimated Start Date: ${fmtContractDate(estStart)}`));
  lines.push(body(`Estimated Completion Date: ${fmtContractDate(estDue)}`));
  if (trimField(snap?.contract_schedule?.source)) {
    lines.push(body(`Schedule source: ${trimField(snap.contract_schedule.source)}`));
  }
  lines.push(blank(6));

  lines.push(heading("Payment Schedule"));
  const items = Array.isArray(snap?.payment_schedule?.items)
    ? snap.payment_schedule.items
    : [];
  if (!items.length) {
    lines.push(body("—"));
  } else {
    for (const it of items) {
      const label = trimField(it.label) || `Item ${it.sequence_number || ""}`;
      const amt =
        it.amount != null
          ? money(it.amount, currency)
          : it.percentage != null
            ? `${Number(it.percentage)}%`
            : "—";
      const due = trimField(it.due_rule) || trimField(it.fixed_due_date) || "";
      lines.push(
        body(
          `${it.sequence_number || "•"}. ${label} — ${amt}` +
            (due ? ` (due: ${due})` : "")
        )
      );
      if (trimField(it.milestone_description)) {
        lines.push(body(`   ${trimField(it.milestone_description)}`));
      }
    }
  }
  lines.push(blank(6));

  lines.push(heading("Warranty"));
  const w = snap?.warranty || {};
  const dur =
    w.duration_value != null
      ? `${w.duration_value} ${trimField(w.duration_unit) || ""}`.trim()
      : "";
  if (dur) lines.push(body(`Duration: ${dur}`));
  lines.push(body(trimField(w.summary) || "—"));
  if (trimField(w.exclusions)) {
    lines.push(subhead("Exclusions"));
    lines.push(body(trimField(w.exclusions)));
  }
  lines.push(blank(6));

  lines.push(heading("Terms"));
  lines.push(body(trimField(snap?.terms?.quote_terms) || "—"));
  lines.push(blank(6));

  lines.push(heading("Legal Notices"));
  const notices = noticeEntries(snap);
  if (!notices.length) {
    lines.push(body("—"));
  } else {
    for (const n of notices) {
      lines.push(subhead(n.key.replace(/_/g, " ")));
      lines.push(body(n.text));
      lines.push(blank(4));
    }
  }

  lines.push({ pageBreak: true });
  lines.push(heading("Signatures"));
  const eventsBySigner = new Map();
  for (const ev of events || []) {
    eventsBySigner.set(String(ev.signer_id), ev);
  }

  for (const s of signers || []) {
    const ev = eventsBySigner.get(String(s.id));
    const method = trimField(ev?.signature_method || "").toLowerCase();
    const sj =
      ev?.signature_json && typeof ev.signature_json === "object"
        ? ev.signature_json
        : {};
    lines.push(
      subhead(
        `${trimField(s.party_name) || "Signer"} — ${trimField(s.role) || "party"}`
      )
    );
    lines.push(body(`Method: ${method || "—"}`));
    lines.push(body(`Signed at: ${ev?.signed_at || s.signed_at || "—"}`));
    if (method === "typed") {
      const typed =
        trimField(sj.typed_name) ||
        trimField(sj.rendered_name) ||
        trimField(s.party_name);
      lines.push(body("Signature (typed):"));
      lines.push(line(typed, { fontSize: 16, italic: true, afterGap: 8 }));
    } else if (method === "drawn") {
      const pathData = extractDrawnPath(sj);
      lines.push(body("Signature (drawn):"));
      if (pathData) {
        lines.push({
          pathBlock: (y) =>
            svgPathToPdfOps(pathData, {
              scale: 0.4,
              offsetX: 54,
              offsetY: y - 8,
              flipY: true,
            }),
          height: 72,
        });
      } else {
        lines.push(body("[drawn signature recorded — path unavailable]"));
      }
    } else {
      lines.push(body("Signature: —"));
    }
    lines.push(blank(10));
  }

  lines.push(heading("Audit Certificate"));
  lines.push(
    body(`Certificate number: ${trimField(certificate.certificate_number)}`)
  );
  lines.push(body(`Verification hash: ${trimField(certificate.content_hash)}`));
  lines.push(body(`Certificate issued: ${certificate.issued_at || "—"}`));
  lines.push(
    body(`Envelope completed: ${envelope.completed_at || "—"}`)
  );
  lines.push(blank(6));

  lines.push(heading("Audit Summary"));
  lines.push(body(`Envelope: ${envelope.id} (${trimField(envelope.status)})`));
  lines.push(
    body(
      `Package: ${pkg.id} v${Number(pkg.version) || 1} (${trimField(pkg.status)})`
    )
  );
  lines.push(body(`Signers: ${(signers || []).length}`));
  lines.push(body(`Signature events: ${(events || []).length}`));
  lines.push(
    body(
      `Event IDs: ${(events || []).map((e) => e.id).join(", ") || "—"}`
    )
  );
  lines.push(blank(6));
  lines.push(body(`Document generated: ${generatedAt}`));
  lines.push(
    body(
      "This PDF was rendered from the immutable contract package snapshot, completed envelope, signature events, and audit certificate. It is not generated from live Contract Builder or live Business Settings."
    )
  );

  return { lines, title };
}

function renderSignedContractPdf(ctx) {
  const generatedAt = ctx.generatedAt || new Date().toISOString();
  const { lines, title } = buildSignedContractLines({
    ...ctx,
    generatedAt,
  });
  const buffer = buildPdfDocument(lines, { generatedAt, title });
  return { buffer, generatedAt, sha256: sha256Hex(buffer) };
}

async function ensurePrivateBucket(bucketName) {
  const { url, key } = getSupabaseConfig();
  const response = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      id: bucketName,
      name: bucketName,
      public: false,
      allowed_mime_types: ["application/pdf"],
      file_size_limit: 20971520,
    }),
  });
  if (response.ok || response.status === 409) return;
  const text = await response.text();
  if (
    response.status === 409 ||
    text.includes('"statusCode":"409"') ||
    text.includes('"statusCode":409') ||
    /already exists|Duplicate/i.test(text)
  ) {
    return;
  }
  throw new Error(`Unable to ensure private signed PDF bucket: ${text}`);
}

async function uploadPrivatePdf({ storageRef, bytes }) {
  const { url, key } = getSupabaseConfig();
  await ensurePrivateBucket(STORAGE_BUCKET);
  const objectPath = String(storageRef)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const uploadResponse = await fetch(
    `${url}/storage/v1/object/${STORAGE_BUCKET}/${objectPath}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": MIME_TYPE,
        "x-upsert": "true",
      },
      body: bytes,
    }
  );
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`Unable to upload signed contract PDF: ${text}`);
  }
  return {
    bucket: STORAGE_BUCKET,
    path: storageRef,
    public: false,
  };
}

async function createSignedDownloadUrl(storageRef, expiresIn = SIGNED_URL_EXPIRES_SEC) {
  const { url, key } = getSupabaseConfig();
  const objectPath = String(storageRef)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const response = await fetch(
    `${url}/storage/v1/object/sign/${STORAGE_BUCKET}/${objectPath}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ expiresIn: Number(expiresIn) || SIGNED_URL_EXPIRES_SEC }),
    }
  );
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_err) {
    data = null;
  }
  if (!response.ok) {
    throw new Error(
      `Unable to create signed download URL: ${text.slice(0, 500)}`
    );
  }
  const signedPath = data?.signedURL || data?.signedUrl || data?.url || "";
  if (!signedPath) {
    throw new Error("Signed URL missing from storage response");
  }
  const absolute = String(signedPath).startsWith("http")
    ? String(signedPath)
    : `${url}/storage/v1${String(signedPath).startsWith("/") ? "" : "/"}${signedPath}`;
  return {
    download_url: absolute,
    expires_in: Number(expiresIn) || SIGNED_URL_EXPIRES_SEC,
  };
}

async function createSignedContractPdf({
  tenantId,
  envelopeId,
  createdBy = null,
  generatedAt = null,
}) {
  const existing = await loadArtifactByEnvelope(tenantId, envelopeId);
  if (existing?.id) {
    return {
      ok: true,
      idempotent: true,
      artifact: serializeArtifact(existing),
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
      error: "Envelope must be completed to generate signed PDF",
      envelope_status: trimField(envelope.status),
    };
  }

  const pkg = await loadPackageFull(tenantId, envelope.package_id);
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
      error: "Package must be executed to generate signed PDF",
      package_status: trimField(pkg.status),
    };
  }

  const snap =
    pkg.snapshot_json && typeof pkg.snapshot_json === "object"
      ? pkg.snapshot_json
      : null;
  if (!snap) {
    return {
      ok: false,
      status: 422,
      code: "snapshot_missing",
      error: "Package snapshot_json is required",
    };
  }

  const certificate = await loadCertificate(tenantId, envelopeId);
  if (!certificate?.id) {
    return {
      ok: false,
      status: 422,
      code: "certificate_missing",
      error: "Audit certificate is required before signed PDF generation",
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

  const events = await loadSignatureEventsFull(tenantId, envelopeId);
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

  const when = generatedAt || new Date().toISOString();
  const { buffer, sha256, generatedAt: genAt } = renderSignedContractPdf({
    snap,
    pkg,
    envelope,
    certificate,
    signers,
    events,
    generatedAt: when,
  });

  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.slice(0, 5).toString() !== "%PDF-") {
    return {
      ok: false,
      status: 500,
      code: "pdf_invalid",
      error: "Generated PDF is invalid",
    };
  }

  const storageRef = buildStoragePath(
    tenantId,
    envelope.project_id,
    envelope.id
  );
  await uploadPrivatePdf({ storageRef, bytes: buffer });

  let inserted = null;
  try {
    const rows = await supabaseRequest(`tenant_contract_signed_artifacts`, {
      method: "POST",
      body: {
        tenant_id: tenantId,
        envelope_id: envelope.id,
        package_id: pkg.id,
        certificate_id: certificate.id,
        project_id: envelope.project_id,
        artifact_type: ARTIFACT_TYPE,
        storage_ref: storageRef,
        sha256,
        file_size: buffer.length,
        mime_type: MIME_TYPE,
        generated_at: genAt,
        generator_version: GENERATOR_VERSION,
        created_by: createdBy || null,
      },
    });
    inserted = Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    const text = String(err?.message || err?.supabaseRaw || "");
    if (/duplicate|unique|23505/i.test(text)) {
      const raced = await loadArtifactByEnvelope(tenantId, envelopeId);
      if (raced?.id) {
        return {
          ok: true,
          idempotent: true,
          artifact: serializeArtifact(raced),
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
      error: "Could not create signed artifact",
    };
  }

  return {
    ok: true,
    idempotent: false,
    artifact: serializeArtifact(inserted),
  };
}

async function listSignedPdfsForEnvelope(tenantId, envelopeId, { withUrl = true } = {}) {
  const rows = await supabaseRequest(
    `tenant_contract_signed_artifacts?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&envelope_id=eq.${encodeURIComponent(envelopeId)}` +
      `&artifact_type=eq.${encodeURIComponent(ARTIFACT_TYPE)}` +
      `&select=*` +
      `&order=generated_at.desc`,
    { method: "GET" }
  );
  const artifacts = (Array.isArray(rows) ? rows : [])
    .map(serializeArtifact)
    .filter(Boolean);

  const out = [];
  for (const art of artifacts) {
    const item = {
      ...art,
      public_download_policy: PUBLIC_DOWNLOAD_POLICY,
      storage_public: false,
    };
    if (withUrl && art.storage_ref) {
      const signed = await createSignedDownloadUrl(art.storage_ref);
      item.download_url = signed.download_url;
      item.download_url_expires_in = signed.expires_in;
    }
    out.push(item);
  }
  return out;
}

module.exports = {
  API_VERSION,
  GENERATOR_VERSION,
  ARTIFACT_TYPE,
  STORAGE_BUCKET,
  SIGNED_URL_EXPIRES_SEC,
  PUBLIC_DOWNLOAD_POLICY,
  validUuid,
  unknownKeys,
  trimField,
  sha256Hex,
  buildStoragePath,
  serializeArtifact,
  businessIdentityFromSnapshot,
  extractDrawnPath,
  buildSignedContractLines,
  renderSignedContractPdf,
  createSignedContractPdf,
  listSignedPdfsForEnvelope,
  createSignedDownloadUrl,
  ensurePrivateBucket,
  sanitizeSvgPath,
  escapePdfText,
};
