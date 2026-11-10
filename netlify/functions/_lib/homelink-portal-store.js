"use strict";

const { supabaseRequest, getSupabaseConfig } = require("./supabase-admin");
const portal = require("./homelink-portal");

const SIGNED_BUCKET = "contract-signed-pdfs";

function rows(data) {
  return Array.isArray(data) ? data : [];
}

async function one(path) {
  const data = await supabaseRequest(path, { method: "GET" });
  return rows(data)[0] || null;
}

async function projectForTenant(tenantId, projectId) {
  return one(
    "tenant_projects?id=eq." + encodeURIComponent(projectId) +
    "&tenant_id=eq." + encodeURIComponent(tenantId) +
    "&select=id,project_name,status,quote_id&limit=1"
  );
}

async function quoteForProject(tenantId, quoteId) {
  if (!quoteId) return null;
  return one(
    "quotes?id=eq." + encodeURIComponent(quoteId) +
    "&tenant_id=eq." + encodeURIComponent(tenantId) +
    "&select=status,accepted_at,project_name,title,total,currency,scope_of_work,labor_area_breakdown,project_address&limit=1"
  );
}

async function brandingForTenant(tenantId) {
  return one(
    "tenant_branding?tenant_id=eq." + encodeURIComponent(tenantId) +
    "&select=business_name,logo_url,business_email,business_phone,business_address&limit=1"
  );
}

async function licenseForTenant(tenantId) {
  const row = await one(
    "tenant_legal_profiles?tenant_id=eq." + encodeURIComponent(tenantId) +
    "&select=contractor_license_number&limit=1"
  );
  return row ? row.contractor_license_number : "";
}

async function signedArtifact(tenantId, projectId) {
  return one(
    "tenant_contract_signed_artifacts?tenant_id=eq." + encodeURIComponent(tenantId) +
    "&project_id=eq." + encodeURIComponent(projectId) +
    "&artifact_type=eq.signed_pdf&select=id,storage_ref,mime_type,project_id&limit=1"
  );
}

async function insertGrant(row) {
  const data = await supabaseRequest("homelink_portal_grants", { method: "POST", body: row });
  return rows(data)[0] || null;
}

async function revokeGrant(tenantId, grantId, revokedAt) {
  const data = await supabaseRequest(
    "homelink_portal_grants?id=eq." + encodeURIComponent(grantId) +
    "&tenant_id=eq." + encodeURIComponent(tenantId) +
    "&revoked_at=is.null",
    { method: "PATCH", body: { revoked_at: revokedAt } }
  );
  return rows(data)[0] || null;
}

async function grantById(tenantId, grantId) {
  return one(
    "homelink_portal_grants?id=eq." + encodeURIComponent(grantId) +
    "&tenant_id=eq." + encodeURIComponent(tenantId) +
    "&select=id,tenant_id,project_id,client_ref,scopes,commercial,expires_at,revoked_at&limit=1"
  );
}

async function grantByHash(tokenHash) {
  return one(
    "homelink_portal_grants?token_hash=eq." + encodeURIComponent(tokenHash) +
    "&select=id,tenant_id,project_id,client_ref,token_hash,scopes,commercial,expires_at,revoked_at&limit=1"
  );
}

async function insertTicket(row) {
  const data = await supabaseRequest("homelink_download_tickets", { method: "POST", body: row });
  return rows(data)[0] || null;
}

async function ticketByHash(tokenHash) {
  return one(
    "homelink_download_tickets?token_hash=eq." + encodeURIComponent(tokenHash) +
    "&select=id,tenant_id,grant_id,project_id,document_kind,token_hash,expires_at,used_at&limit=1"
  );
}

async function markTicketUsed(ticketId, usedAt) {
  const data = await supabaseRequest(
    "homelink_download_tickets?id=eq." + encodeURIComponent(ticketId) + "&used_at=is.null",
    { method: "PATCH", body: { used_at: usedAt } }
  );
  return rows(data)[0] || null;
}

async function insertServiceRequest(row) {
  const data = await supabaseRequest("homelink_service_requests", { method: "POST", body: row });
  return rows(data)[0] || null;
}

async function saveReview(row) {
  const data = await supabaseRequest("homelink_reviews?on_conflict=grant_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: row
  });
  return rows(data)[0] || null;
}

async function reviewForGrant(grantId) {
  return one(
    "homelink_reviews?grant_id=eq." + encodeURIComponent(grantId) +
    "&select=opinion,project_type,city,before_photo,after_photo,visibility&limit=1"
  );
}

async function insertInvite(row) {
  const data = await supabaseRequest("homelink_invitations", { method: "POST", body: row });
  return rows(data)[0] || null;
}

async function inviteByHash(tokenHash) {
  return one(
    "homelink_invitations?token_hash=eq." + encodeURIComponent(tokenHash) +
    "&select=id,tenant_id,grant_id,token_hash,expires_at,used_at&limit=1"
  );
}

async function markInviteUsed(inviteId, usedAt) {
  const data = await supabaseRequest(
    "homelink_invitations?id=eq." + encodeURIComponent(inviteId) + "&used_at=is.null",
    { method: "PATCH", body: { used_at: usedAt } }
  );
  return rows(data)[0] || null;
}

async function rotateGrantToken(tenantId, grantId, tokenHash) {
  const data = await supabaseRequest(
    "homelink_portal_grants?id=eq." + encodeURIComponent(grantId) +
    "&tenant_id=eq." + encodeURIComponent(tenantId),
    { method: "PATCH", body: { token_hash: tokenHash } }
  );
  return rows(data)[0] || null;
}

async function readPrivatePdf(storageRef) {
  const { url, key } = getSupabaseConfig();
  const objectPath = String(storageRef).split("/").map(encodeURIComponent).join("/");
  const response = await fetch(url + "/storage/v1/object/" + SIGNED_BUCKET + "/" + objectPath, {
    headers: { apikey: key, Authorization: "Bearer " + key }
  });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length ? bytes : null;
}

module.exports = {
  projectForTenant,
  quoteForProject,
  brandingForTenant,
  licenseForTenant,
  signedArtifact,
  insertGrant,
  rotateGrantToken,
  revokeGrant,
  insertInvite,
  inviteByHash,
  markInviteUsed,
  grantByHash,
  grantById,
  insertTicket,
  ticketByHash,
  markTicketUsed,
  insertServiceRequest,
  saveReview,
  reviewForGrant,
  readPrivatePdf
};
