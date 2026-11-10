"use strict";

const portal = require("./homelink-portal");

function fail(status, code) {
  return { ok: false, status: status, code: code };
}

function requestSubject(event) {
  const query = event && event.queryStringParameters ? event.queryStringParameters : {};
  let body = {};
  if (event && event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (_err) {
      body = {};
    }
  }
  if (!body || typeof body !== "object") body = {};
  const subject = {};
  ["project_id", "client_ref", "tenant_id"].forEach(function (key) {
    if (body[key] != null && String(body[key]) !== "") subject[key] = body[key];
    else if (query[key] != null && String(query[key]) !== "") subject[key] = query[key];
  });
  return subject;
}

async function grantFromBearer(store, event, scope, now) {
  const token = portal.bearerToken(event);
  if (!token) return fail(401, "missing_grant");
  const row = await store.grantByHash(portal.sha256(token));
  if (!row || !portal.tokenMatches(row.token_hash, token)) return fail(401, "missing_grant");
  const allowed = portal.grantAllows(row, scope, now);
  if (!allowed.ok) return allowed;
  const subject = portal.subjectMatches(row, requestSubject(event));
  if (!subject.ok) return subject;
  return { ok: true, grant: row };
}

async function issueAccess(store, actor, input, now, env) {
  const src = input && typeof input === "object" ? input : {};
  if (Object.prototype.hasOwnProperty.call(src, "tenant_id")) return fail(400, "tenant_forbidden");
  const projectId = String(src.project_id || "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(projectId)) return fail(400, "invalid_grant");
  const project = await store.projectForTenant(actor.tenantId, projectId);
  if (!project || String(project.id).toLowerCase() !== projectId) return fail(404, "project_not_found");
  if (project.tenant_id && String(project.tenant_id).toLowerCase() !== String(actor.tenantId).toLowerCase()) {
    return fail(403, "project_mismatch");
  }
  const issued = portal.validateIssue({
    project_id: projectId,
    client_ref: portal.clientRefFromName(project.client_name),
    expires_at: src.expires_at,
    scopes: src.scopes,
    commercial: src.commercial
  }, now);
  if (!issued.ok) return issued;
  const hidden = portal.newToken();
  const saved = await store.insertGrant({
    tenant_id: actor.tenantId,
    project_id: project.id,
    client_ref: issued.grant.clientRef,
    token_hash: portal.sha256(hidden),
    scopes: issued.grant.scopes,
    commercial: issued.grant.commercial,
    expires_at: issued.grant.expiresAt,
    created_by: /^[0-9a-f-]{36}$/i.test(String(actor.membershipId || "")) ? actor.membershipId : null
  });
  if (!saved) return fail(500, "not_saved");
  const invite = portal.newToken();
  const inviteRow = await store.insertInvite({
    tenant_id: actor.tenantId,
    grant_id: saved.id,
    token_hash: portal.sha256(invite),
    expires_at: new Date(Number(now || Date.now()) + portal.INVITE_MS).toISOString()
  });
  if (!inviteRow) return fail(500, "not_saved");
  return {
    ok: true,
    status: 200,
    grant_id: saved.id,
    client_ref: issued.grant.clientRef,
    project_id: project.id,
    expires_at: issued.grant.expiresAt,
    invite_url: portal.inviteUrl(invite, env)
  };
}

async function revokeAccess(store, tenantId, grantId, now) {
  if (!/^[0-9a-f-]{36}$/i.test(String(grantId || ""))) return fail(400, "invalid_grant");
  const saved = await store.revokeGrant(tenantId, grantId, new Date(Number(now || Date.now())).toISOString());
  if (!saved) return fail(404, "not_found");
  return { ok: true, status: 200, grant_id: saved.id, revoked_at: saved.revoked_at };
}

async function redeemInvite(store, input, now) {
  const src = input && typeof input === "object" ? input : {};
  const invite = String(src.invite || "").trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(invite)) return fail(401, "missing_invite");
  const row = await store.inviteByHash(portal.sha256(invite));
  if (!row || !portal.tokenMatches(row.token_hash, invite)) return fail(404, "not_found");
  const usable = portal.inviteUsable(row, now);
  if (!usable.ok) return usable;
  const grant = await store.grantById(row.tenant_id, row.grant_id);
  const allowed = portal.grantAllows(grant, "project:read", now);
  if (!allowed.ok) return allowed;
  const subject = portal.subjectMatches(grant, src);
  if (!subject.ok) return subject;
  const marked = await store.markInviteUsed(row.id, new Date(Number(now || Date.now())).toISOString());
  if (!marked) return fail(409, "used");
  const token = portal.newToken();
  const rotated = await store.rotateGrantToken(grant.tenant_id, grant.id, portal.sha256(token));
  if (!rotated) return fail(500, "not_saved");
  return { ok: true, status: 200, token: token };
}

async function projectSummary(store, grant) {
  const project = await store.projectForTenant(grant.tenant_id, grant.project_id);
  if (!project || project.id !== grant.project_id) return fail(404, "project_not_found");
  const quote = await store.quoteForProject(grant.tenant_id, project.quote_id);
  const branding = await store.brandingForTenant(grant.tenant_id);
  const licenseNumber = await store.licenseForTenant(grant.tenant_id);
  const artifact = await store.signedArtifact(grant.tenant_id, grant.project_id);
  const review = await store.reviewForGrant(grant.id);
  const summary = portal.projectSummary({
    grant: grant,
    project: project,
    quote: quote,
    branding: branding,
    licenseNumber: licenseNumber,
    signedContract: Boolean(artifact && artifact.project_id === grant.project_id),
    sharedReview: review
  });
  if (portal.containsForbidden(summary)) return fail(500, "unsafe_response");
  return { ok: true, status: 200, body: summary };
}

async function openTicket(store, grant, body, now) {
  const kind = body && body.document === "contract" ? "contract" : body && body.document === "quote" ? "quote" : "";
  if (!kind) return fail(400, "invalid_document");
  const scope = kind === "quote" ? "quote:download" : "contract:download";
  const allowed = portal.grantAllows(grant, scope, now);
  if (!allowed.ok) return allowed;
  const subject = portal.subjectMatches(grant, body);
  if (!subject.ok) return subject;
  const project = await store.projectForTenant(grant.tenant_id, grant.project_id);
  if (!project) return fail(404, "project_not_found");
  if (kind === "quote") {
    const quote = await store.quoteForProject(grant.tenant_id, project.quote_id);
    const view = portal.quoteDownloadView(quote);
    if (!view.ok) return view;
  } else {
    const artifact = await store.signedArtifact(grant.tenant_id, grant.project_id);
    if (!artifact) return fail(404, "contract_not_ready");
  }
  const ticket = portal.newToken();
  const expiresAt = new Date(Number(now || Date.now()) + portal.TICKET_MS).toISOString();
  const saved = await store.insertTicket({
    tenant_id: grant.tenant_id,
    grant_id: grant.id,
    project_id: grant.project_id,
    document_kind: kind,
    token_hash: portal.sha256(ticket),
    expires_at: expiresAt
  });
  if (!saved) return fail(500, "not_saved");
  return { ok: true, status: 200, ticket: ticket, expires_at: expiresAt };
}

async function readDownload(store, ticket, now) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(ticket || ""))) return fail(401, "missing_ticket");
  const row = await store.ticketByHash(portal.sha256(ticket));
  if (!row || !portal.tokenMatches(row.token_hash, ticket)) return fail(404, "not_found");
  const usable = portal.consumeTicket(row, now);
  if (!usable.ok) return usable;
  const grant = await store.grantById(row.tenant_id, row.grant_id);
  const scope = row.document_kind === "quote" ? "quote:download" : "contract:download";
  const allowed = portal.grantAllows(grant, scope, now);
  if (!allowed.ok || !grant || grant.project_id !== row.project_id) {
    return fail(allowed.ok ? 403 : allowed.status, allowed.ok ? "project_mismatch" : allowed.code);
  }
  const marked = await store.markTicketUsed(row.id, new Date(Number(now || Date.now())).toISOString());
  if (!marked) return fail(409, "used");
  const project = await store.projectForTenant(row.tenant_id, row.project_id);
  if (!project) return fail(404, "project_not_found");
  if (row.document_kind === "quote") {
    const quote = await store.quoteForProject(row.tenant_id, project.quote_id);
    const view = portal.quoteDownloadView(quote);
    if (!view.ok || portal.containsForbidden(view.view)) return fail(404, "not_accepted");
    return { ok: true, status: 200, kind: "quote", view: view.view, filename: "accepted-quote.pdf" };
  }
  const artifact = await store.signedArtifact(row.tenant_id, row.project_id);
  if (!artifact || artifact.project_id !== row.project_id) return fail(404, "contract_not_ready");
  const bytes = await store.readPrivatePdf(artifact.storage_ref);
  if (!bytes) return fail(404, "file_missing");
  return { ok: true, status: 200, kind: "contract", bytes: bytes, filename: "signed-contract.pdf" };
}

async function submitRequest(store, grant, body) {
  const parsed = portal.serviceRequestInput(body);
  if (!parsed.ok) return parsed;
  const subject = portal.subjectMatches(grant, body);
  if (!subject.ok) return subject;
  const project = await store.projectForTenant(grant.tenant_id, grant.project_id);
  if (!project || project.id !== grant.project_id) return fail(404, "project_not_found");
  const saved = await store.insertServiceRequest({
    tenant_id: grant.tenant_id,
    grant_id: grant.id,
    project_id: grant.project_id,
    client_ref: grant.client_ref,
    title: parsed.title,
    details: parsed.details,
    status: "submitted"
  });
  if (!saved) return fail(500, "not_saved");
  return { ok: true, status: 200, request_id: saved.id, request_status: "submitted" };
}

async function submitReview(store, grant, body) {
  const record = portal.reviewRecord(body || {});
  const subject = portal.subjectMatches(grant, body);
  if (!subject.ok) return subject;
  const saved = await store.saveReview({
    tenant_id: grant.tenant_id,
    grant_id: grant.id,
    project_id: grant.project_id,
    client_ref: grant.client_ref,
    opinion: record.opinion,
    project_type: record.project_type,
    city: record.city,
    before_photo: record.before_photo,
    after_photo: record.after_photo,
    visibility: record.visibility,
    updated_at: new Date().toISOString()
  });
  if (!saved) return fail(500, "not_saved");
  const shared = portal.sharedReview(record);
  if (shared && portal.containsForbidden(shared)) return fail(500, "unsafe_response");
  return {
    ok: true,
    status: 200,
    visibility: record.visibility,
    review: record.visibility === "shared" ? shared : {
      opinion: record.opinion,
      project_type: record.project_type,
      city: record.city,
      before_photo: record.before_photo,
      after_photo: record.after_photo,
      visibility: "private"
    }
  };
}

module.exports = {
  requestSubject,
  grantFromBearer,
  issueAccess,
  revokeAccess,
  redeemInvite,
  projectSummary,
  openTicket,
  readDownload,
  submitRequest,
  submitReview
};
