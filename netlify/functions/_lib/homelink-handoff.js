"use strict";

const crypto = require("crypto");

const TTL_MS = 2 * 60 * 1000;
const STATUSES = {
  signed: true,
  deposit_paid: true,
  assigned: true,
  in_progress: true,
  completed: true,
  cancelled: true
};

function trim(value) {
  return String(value == null ? "" : value).trim();
}

function secretReady(secret) {
  return typeof secret === "string" && secret.length >= 32;
}

function sign(secret, text) {
  return crypto.createHmac("sha256", secret).update(text, "utf8").digest("hex");
}

function same(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function projectView(project) {
  const status = trim(project && project.status);
  return {
    id: trim(project && project.id).toLowerCase(),
    project_name: trim(project && (project.project_name || project.name)).slice(0, 120),
    status: STATUSES[status] ? status : "signed"
  };
}

function canonical(src) {
  const body = src && typeof src === "object" ? src : {};
  const grant = body.grant && typeof body.grant === "object" ? body.grant : {};
  return {
    issued_at: Number(body.issued_at),
    nonce: trim(body.nonce),
    action: body.action === "revoke" ? "revoke" : "issue",
    tenant_id: trim(body.tenant_id).toLowerCase(),
    membership_id: trim(body.membership_id).toLowerCase(),
    tenant_name: trim(body.tenant_name).slice(0, 80),
    project: projectView(body.project),
    grant: {
      project_id: trim(grant.project_id).toLowerCase(),
      client_ref: trim(grant.client_ref),
      expires_at: trim(grant.expires_at),
      scopes: (Array.isArray(grant.scopes) ? grant.scopes : []).map(trim).filter(Boolean),
      commercial: (Array.isArray(grant.commercial) ? grant.commercial : []).map(trim).filter(Boolean)
    },
    grant_id: trim(body.grant_id).toLowerCase()
  };
}

function payloadText(proof) {
  const row = canonical(proof);
  return [
    row.issued_at,
    row.nonce,
    row.action,
    row.tenant_id,
    row.membership_id,
    row.tenant_name,
    row.project.id,
    row.project.project_name,
    row.project.status,
    row.grant.project_id,
    row.grant.client_ref,
    row.grant.expires_at,
    row.grant.scopes.join(","),
    row.grant.commercial.join(","),
    row.grant_id
  ].join("\n");
}

function seal(secret, input, now) {
  if (!secretReady(secret)) return { ok: false, code: "handoff_not_configured" };
  const src = input && typeof input === "object" ? input : {};
  const proof = canonical({
    issued_at: Number(now || Date.now()),
    nonce: crypto.randomBytes(32).toString("base64url"),
    action: src.action,
    tenant_id: src.tenantId,
    membership_id: src.membershipId,
    tenant_name: src.tenantName,
    project: src.project,
    grant: src.grant,
    grant_id: src.grantId
  });
  if (!/^[0-9a-f-]{36}$/.test(proof.tenant_id) || !/^[0-9a-f-]{36}$/.test(proof.membership_id)) {
    return { ok: false, code: "invalid_handoff" };
  }
  if (proof.action === "revoke" && !/^[0-9a-f-]{36}$/.test(proof.grant_id)) {
    return { ok: false, code: "invalid_grant" };
  }
  if (proof.action === "issue" && proof.grant.project_id !== proof.project.id) {
    return { ok: false, code: "project_mismatch" };
  }
  proof.mac = sign(secret, payloadText(proof));
  return { ok: true, proof: proof };
}

function open(secret, proof, now) {
  if (!secretReady(secret)) return { ok: false, status: 503, code: "handoff_not_configured" };
  const row = canonical(proof);
  const current = Number(now || Date.now());
  if (!Number.isFinite(row.issued_at) || current + 5000 < row.issued_at || current - row.issued_at > TTL_MS) {
    return { ok: false, status: 401, code: "expired" };
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(row.nonce)) return { ok: false, status: 401, code: "invalid_handoff" };
  if (!same(sign(secret, payloadText(row)), proof && proof.mac)) {
    return { ok: false, status: 401, code: "invalid_handoff" };
  }
  return {
    ok: true,
    action: row.action,
    tenantId: row.tenant_id,
    membershipId: row.membership_id,
    tenantName: row.tenant_name || "Contractor",
    project: row.project,
    grant: row.grant,
    grantId: row.grant_id,
    handoffHash: crypto.createHash("sha256").update(row.nonce, "utf8").digest("hex")
  };
}

module.exports = {
  TTL_MS,
  seal,
  open
};
