/**
 * Owner-only: create a seller or supervisor membership (profiles row).
 * Step 3E-C6-B — no auth_user_id, devices, or sessions.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  resolveMembershipByEmail,
} = require("./_lib/membership-resolve");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

const ALLOWED_ROLES = new Set(["seller", "supervisor"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function normEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normText(value, maxLen) {
  return String(value || "")
    .trim()
    .slice(0, maxLen || 200);
}

function emailLocalPart(email) {
  const at = String(email || "").indexOf("@");
  return at > 0 ? email.slice(0, at) : "";
}

function serializeMembership(row) {
  return {
    id: row.id,
    email: row.email || null,
    display_name: String(row.display_name || "").trim(),
    full_name: String(row.full_name || "").trim(),
    role: row.role || null,
    status: row.status || null,
    invited_at: row.invited_at || null,
    accepted_at: row.accepted_at || null,
    created_at: row.created_at || null,
  };
}

function isOwnerEmail(email, ctx) {
  const em = normEmail(email);
  if (!em) return false;
  if (normEmail(ctx?.membership?.email) === em) return true;
  if (normEmail(ctx?.tenant?.owner_email) === em) return true;
  return false;
}

function isDuplicateKeyError(err) {
  const msg = String(err?.message || err?.supabaseRaw || "").toLowerCase();
  return msg.includes("23505") || msg.includes("duplicate key") || msg.includes("unique");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await requireOwnerMembership(event);
    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { error: "Invalid JSON" });
    }

    const email = normEmail(body.email);
    if (!email) {
      return json(400, { error: "email is required", code: "invalid_email" });
    }
    if (!EMAIL_RE.test(email)) {
      return json(400, { error: "email format is invalid", code: "invalid_email" });
    }

    const role = normRole(body.role);
    if (!ALLOWED_ROLES.has(role)) {
      return json(400, {
        error: "role must be seller or supervisor",
        code: "invalid_role",
      });
    }

    if (isOwnerEmail(email, ctx)) {
      return json(403, {
        error: "Cannot create a membership for the owner email",
        code: "owner_email_forbidden",
      });
    }

    const existing = await resolveMembershipByEmail(
      supabaseRequest,
      ctx.tenant.id,
      email
    );
    if (existing?.id) {
      return json(409, {
        error: "A membership with this email already exists for this tenant",
        code: "membership_exists",
        membership: serializeMembership(existing),
      });
    }

    const displayNameInput = normText(body.display_name || body.displayName, 200);
    const fullNameInput = normText(body.full_name || body.fullName, 200);
    const displayName =
      displayNameInput || fullNameInput || emailLocalPart(email) || email;
    const fullName = fullNameInput || displayNameInput || displayName;

    const nowIso = new Date().toISOString();
    const insertBody = {
      tenant_id: ctx.tenant.id,
      email,
      role,
      status: "active",
      display_name: displayName,
      full_name: fullName,
      invited_by_membership_id: ctx.membership.id,
      invited_at: nowIso,
      accepted_at: nowIso,
    };

    let created;
    try {
      const rows = await supabaseRequest("profiles", {
        method: "POST",
        body: insertBody,
      });
      created = Array.isArray(rows) ? rows[0] : rows;
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const dup = await resolveMembershipByEmail(
          supabaseRequest,
          ctx.tenant.id,
          email
        );
        return json(409, {
          error: "A membership with this email already exists for this tenant",
          code: "membership_exists",
          membership: dup?.id ? serializeMembership(dup) : null,
        });
      }
      throw err;
    }

    if (!created?.id) {
      return json(500, { error: "Membership row was not returned after insert" });
    }

    return json(200, {
      ok: true,
      membership: serializeMembership(created),
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
