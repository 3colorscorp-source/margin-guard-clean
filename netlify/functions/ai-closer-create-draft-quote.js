/**
 * AI Closer Step 9A — dry-run only draft quote conversion validation.
 * Validates owner/admin auth, tenant scope, prequote eligibility, and idempotency.
 * Does NOT create quotes, invoices, payments, or any database writes.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  membershipIsActive,
  membershipRole,
  resolveMembershipByEmail,
  PROFILE_SELECT,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

const ELIGIBLE_PREQUOTE_STATUSES = new Set([
  "reviewed",
  "good_lead",
  "needs_site_visit",
]);

const REQUIRED_CONFIRMATIONS = [
  "owner_reviewed_lead",
  "scope_confirmed",
  "measurements_confirmed",
  "materials_status_confirmed",
  "start_date_reviewed",
  "final_price_approved",
];

const SAFE_PREQUOTE_SELECT = [
  "id",
  "tenant_id",
  "status",
  "project_name",
  "client_name",
  "client_email",
  "scope_notes",
].join(",");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function trimStr(value, maxLen) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return maxLen && s.length > maxLen ? s.slice(0, maxLen) : s;
}

function parsePositivePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function confirmationsValid(confirmations) {
  if (!confirmations || typeof confirmations !== "object" || Array.isArray(confirmations)) {
    return false;
  }
  return REQUIRED_CONFIRMATIONS.every((key) => confirmations[key] === true);
}

async function resolveOwnerAdminContext(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e && !session?.u) {
    throwGuard(401, "Unauthorized", "no_session");
  }

  let membership = null;

  const authUserId = String(session?.u || "").trim();
  if (authUserId) {
    const rows = await supabaseRequest(
      `profiles?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=${PROFILE_SELECT}&limit=10`
    );
    const list = Array.isArray(rows) ? rows : [];
    membership =
      list.find(
        (row) => membershipIsActive(row) && OWNER_ADMIN_ROLES.has(membershipRole(row))
      ) || null;
  }

  if (!membership && session?.e && session?.c) {
    const tenant = await resolveTenantFromSession(session);
    if (tenant?.id) {
      const byEmail = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
      if (
        byEmail?.id &&
        membershipIsActive(byEmail) &&
        OWNER_ADMIN_ROLES.has(membershipRole(byEmail))
      ) {
        membership = byEmail;
      }
    }
  }

  if (!membership?.tenant_id) {
    throwGuard(403, "Owner or admin access required", "owner_required");
  }

  return {
    tenantId: String(membership.tenant_id),
    membership,
  };
}

async function readPrequote(prequoteId, tenantId) {
  const path =
    `ai_closer_prequotes?id=eq.${encodeURIComponent(prequoteId)}` +
    `&tenant_id=eq.${encodeURIComponent(tenantId)}` +
    `&select=${SAFE_PREQUOTE_SELECT}` +
    `&limit=1`;

  const rows = await supabaseRequest(path, { method: "GET" });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function readExistingConversion(prequoteId, tenantId) {
  const path =
    `ai_closer_quote_conversions?ai_closer_prequote_id=eq.${encodeURIComponent(prequoteId)}` +
    `&tenant_id=eq.${encodeURIComponent(tenantId)}` +
    `&select=id,status` +
    `&limit=1`;

  const rows = await supabaseRequest(path, { method: "GET" });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const { tenantId } = await resolveOwnerAdminContext(event);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    if (body.dry_run !== true) {
      return json(400, {
        ok: false,
        error: "Step 9A is dry-run only. No draft quote was created.",
      });
    }

    const prequoteId = trimStr(body.prequote_id ?? body.prequoteId, 80);
    if (!prequoteId || !UUID_RE.test(prequoteId)) {
      return json(400, { ok: false, error: "Valid prequote_id is required" });
    }

    const finalPrice = parsePositivePrice(body.final_price_owner_approved);
    if (finalPrice == null) {
      return json(400, {
        ok: false,
        error: "final_price_owner_approved must be a number greater than zero",
      });
    }

    if (!confirmationsValid(body.owner_confirmations)) {
      return json(400, {
        ok: false,
        error: "All owner confirmations are required and must be true",
      });
    }

    let prequote;
    try {
      prequote = await readPrequote(prequoteId, tenantId);
    } catch (_err) {
      return json(502, { ok: false, error: "Unable to load pre-quote" });
    }

    if (!prequote?.id) {
      return json(404, { ok: false, error: "Pre-quote not found" });
    }

    const prequoteStatus = String(prequote.status || "").toLowerCase();
    if (!ELIGIBLE_PREQUOTE_STATUSES.has(prequoteStatus)) {
      return json(409, {
        ok: false,
        error: "Pre-quote status is not eligible for draft quote conversion",
      });
    }

    let existingConversion;
    try {
      existingConversion = await readExistingConversion(prequoteId, tenantId);
    } catch (_err) {
      return json(502, { ok: false, error: "Unable to check conversion status" });
    }

    if (existingConversion?.id) {
      return json(409, {
        ok: false,
        error:
          "A conversion record already exists for this pre-quote. No draft quote was created.",
      });
    }

    return json(200, {
      ok: true,
      dry_run: true,
      message: "Draft quote conversion validated. No quote was created.",
      conversion_plan: {
        prequote_id: String(prequote.id),
        tenant_id: tenantId,
        future_quote_status: "DRAFT",
        project_name: trimStr(prequote.project_name, 500),
        client_name: trimStr(prequote.client_name, 500),
        client_email: trimStr(prequote.client_email, 320),
        estimated_amount: finalPrice,
        scope_notes: trimStr(prequote.scope_notes, 8000),
        will_create_quote: false,
        will_create_quote_items: false,
        will_create_quote_labor: false,
        will_create_invoice: false,
        will_create_payment: false,
        will_publish: false,
        will_email_client: false,
      },
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message || "Forbidden" });
    }
    return json(500, { ok: false, error: "Server error" });
  }
};
