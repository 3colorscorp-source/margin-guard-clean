/**
 * Step 3E-C18-C — owner/admin safe quote metadata update (metadata only; no pricing/status).
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  membershipRole,
  membershipIsActive,
  resolveMembershipByEmail,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");
const {
  UUID_RE,
  EDITABLE_FIELD_NAMES,
  evaluateQuoteEditGuard,
} = require("./_lib/quote-edit-guard");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

const ALLOWED_BODY_KEYS = new Set([
  "quote_id",
  "confirm_sent_update",
  ...EDITABLE_FIELD_NAMES,
]);

const SHORT_TEXT_MAX = 255;
const LONG_TEXT_MAX = 5000;

const DATE_FIELDS = new Set(["start_date", "due_date"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseBody(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function trimStr(value, maxLen) {
  const s = String(value ?? "").trim();
  if (!maxLen || maxLen < 1) return s;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function normIsoDate(raw) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const slice = t.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(slice) ? slice : undefined;
}

function normalizeEmail(raw) {
  const s = trimStr(raw, SHORT_TEXT_MAX).toLowerCase();
  return s || null;
}

function normalizeShortText(raw) {
  const s = trimStr(raw, SHORT_TEXT_MAX);
  return s || null;
}

function normalizeLongText(raw) {
  const s = trimStr(raw, LONG_TEXT_MAX);
  return s || null;
}

function findUnknownBodyKeys(body) {
  const unknown = [];
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.has(key)) {
      unknown.push(key);
    }
  }
  return unknown.sort();
}

async function requireOwnerOrAdmin(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e || !session?.c) {
    throwGuard(401, "Unauthorized", "no_session");
  }

  const tenant = await resolveTenantFromSession(session);
  if (!tenant?.id) {
    throwGuard(422, "Tenant not found for this session.", "tenant_not_found");
  }

  const membership = await resolveMembershipByEmail(supabaseRequest, tenant.id, session.e);
  if (!membership?.id) {
    throwGuard(403, "Membership not found", "membership_not_found");
  }
  if (!membershipIsActive(membership)) {
    throwGuard(403, "Membership is not active", "membership_inactive");
  }
  const role = membershipRole(membership);
  if (!OWNER_ADMIN_ROLES.has(role)) {
    throwGuard(403, "Owner or admin membership required", "owner_required");
  }

  return { tenant, membership };
}

function buildEditablePatch(body) {
  const patch = {};
  const updatedFields = [];

  for (const key of EDITABLE_FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;

    if (DATE_FIELDS.has(key)) {
      const normalized = normIsoDate(body[key]);
      if (normalized === undefined) {
        return { error: "invalid_date", field: key };
      }
      patch[key] = normalized;
      updatedFields.push(key);
      continue;
    }

    if (key === "client_email") {
      patch[key] = normalizeEmail(body[key]);
      updatedFields.push(key);
      continue;
    }

    if (key === "notes" || key === "terms") {
      patch[key] = normalizeLongText(body[key]);
      updatedFields.push(key);
      continue;
    }

    patch[key] = normalizeShortText(body[key]);
    updatedFields.push(key);
  }

  return { patch, updatedFields };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);

    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { ok: false, error: "Invalid JSON", code: "invalid_json" });
    }

    const unknownKeys = findUnknownBodyKeys(body);
    if (unknownKeys.length > 0) {
      return json(400, {
        ok: false,
        error: "Unknown or disallowed fields in request body.",
        code: "unknown_fields",
        fields: unknownKeys,
      });
    }

    const quoteId = trimStr(body.quote_id, 64);
    if (!quoteId) {
      return json(400, {
        ok: false,
        error: "quote_id is required",
        code: "quote_id_required",
      });
    }
    if (!UUID_RE.test(quoteId)) {
      return json(400, {
        ok: false,
        error: "Invalid quote_id",
        code: "invalid_quote_id",
      });
    }

    const guardBefore = await evaluateQuoteEditGuard(tenantId, quoteId);

    if (guardBefore.notFound) {
      return json(404, {
        ok: false,
        error: "Quote not found",
        code: "quote_not_found",
      });
    }

    if (guardBefore.invalidQuoteId) {
      return json(400, {
        ok: false,
        error: "Invalid quote_id",
        code: "invalid_quote_id",
      });
    }

    if (guardBefore.edit?.locked || !guardBefore.edit?.is_editable) {
      return json(422, {
        ok: false,
        error: "Quote is locked and cannot be edited.",
        code: "quote_locked",
        lock_reasons: guardBefore.edit?.lock_reasons || [],
      });
    }

    const warnings = guardBefore.edit?.warnings || [];
    if (warnings.includes("quote_viewed_or_sent") && body.confirm_sent_update !== true) {
      return json(409, {
        ok: false,
        error:
          "This quote was already sent or viewed. Set confirm_sent_update to true to proceed.",
        code: "sent_quote_confirmation_required",
        warnings,
      });
    }

    const built = buildEditablePatch(body);
    if (built.error === "invalid_date") {
      return json(400, {
        ok: false,
        error: `Invalid date format for ${built.field}. Use YYYY-MM-DD or null.`,
        code: "invalid_date",
        field: built.field,
      });
    }

    const { patch, updatedFields } = built;
    if (!updatedFields.length) {
      return json(400, {
        ok: false,
        error: "No editable fields provided.",
        code: "no_edit_fields",
      });
    }

    const nowIso = new Date().toISOString();
    const tidEnc = encodeURIComponent(tenantId);
    const qidEnc = encodeURIComponent(quoteId);

    await supabaseRequest(`quotes?id=eq.${qidEnc}&tenant_id=eq.${tidEnc}`, {
      method: "PATCH",
      body: {
        ...patch,
        updated_at: nowIso,
      },
    });

    const guardAfter = await evaluateQuoteEditGuard(tenantId, quoteId);

    return json(200, {
      ok: true,
      quote: guardAfter.quote,
      edit: guardAfter.edit,
      updated_fields: updatedFields,
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("[update-tenant-quote-edit]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
