/**
 * AI Closer Step 9A/9B — draft quote conversion validation and backend-only DRAFT creation.
 * Dry-run validates without writes. Create mode writes only ai_closer_quote_conversions + quotes.
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function normIsoDate(value) {
  const s = trimStr(value, 32);
  if (!s || !ISO_DATE_RE.test(s)) return "";
  const d = new Date(`${s}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return "";
  return s;
}

function isDuplicateKeyError(err) {
  const text = String(err?.supabaseRaw || err?.message || "").toLowerCase();
  return /23505|duplicate key|unique constraint/i.test(text);
}

function isMissingColumnError(err, columnHint) {
  const text = String(err?.supabaseRaw || err?.message || "").toLowerCase();
  if (!/42703|column|schema cache|could not find/i.test(text)) return false;
  if (!columnHint) return true;
  return text.includes(String(columnHint).toLowerCase());
}

function buildSafeNotes(prequote, ownerNote) {
  const parts = [];
  const scope = trimStr(prequote?.scope_notes, 8000);
  const note = trimStr(ownerNote, 5000);
  if (scope) parts.push(scope);
  if (note) parts.push(note);
  return parts.join("\n\n").trim();
}

function buildConversionMetadata({ finalPrice, startDate, ownerNote }) {
  const meta = {
    final_price_owner_approved: finalPrice,
    source: "ai_closer_step9b",
  };
  if (startDate) meta.start_date = startDate;
  const note = trimStr(ownerNote, 5000);
  if (note) meta.owner_note = note;
  return meta;
}

function buildQuoteInsertPayload({ tenantId, prequote, finalPrice, startDate, ownerNote }) {
  // Step 8C preflight on live Supabase: public.quotes.estimated_amount (not total/currency).
  const payload = {
    tenant_id: tenantId,
    project_name: trimStr(prequote.project_name, 500) || "Project",
    client_name: trimStr(prequote.client_name, 500),
    client_email: trimStr(prequote.client_email, 320),
    estimated_amount: finalPrice,
    status: "DRAFT",
  };

  const safeNotes = buildSafeNotes(prequote, ownerNote);
  if (safeNotes) payload.notes = safeNotes;
  if (startDate) payload.start_date = startDate;

  return payload;
}

function quotePayloadVariants(base) {
  const variants = [base];
  if (base.notes) variants.push({ ...base, notes: undefined });
  if (base.start_date) variants.push({ ...base, start_date: undefined });
  if (base.notes && base.start_date) {
    variants.push({ ...base, notes: undefined, start_date: undefined });
  }
  return variants;
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
    createdBy: membership?.id && UUID_RE.test(String(membership.id)) ? String(membership.id) : null,
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
    `&select=id,status,official_quote_id,ai_closer_prequote_id` +
    `&limit=1`;

  const rows = await supabaseRequest(path, { method: "GET" });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function insertConversionRow({ tenantId, prequoteId, createdBy, metadata }) {
  const body = {
    tenant_id: tenantId,
    ai_closer_prequote_id: prequoteId,
    status: "draft_pending",
    conversion_metadata: metadata,
  };
  if (createdBy) body.created_by = createdBy;

  const rows = await supabaseRequest("ai_closer_quote_conversions", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body,
  });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function markConversionFailed(conversionId) {
  try {
    await supabaseRequest(
      `ai_closer_quote_conversions?id=eq.${encodeURIComponent(conversionId)}`,
      {
        method: "PATCH",
        body: { status: "failed" },
      }
    );
  } catch (_err) {
    // Best-effort only; do not leak details to client.
  }
}

async function finalizeConversionRow(conversionId, quoteId) {
  const rows = await supabaseRequest(
    `ai_closer_quote_conversions?id=eq.${encodeURIComponent(conversionId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: {
        official_quote_id: quoteId,
        status: "draft_created",
      },
    }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function insertDraftQuote(payload) {
  const variants = quotePayloadVariants(payload);
  let lastErr = null;

  for (const variant of variants) {
    try {
      const rows = await supabaseRequest("quotes", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: variant,
      });
      const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (row?.id) return row;
    } catch (err) {
      lastErr = err;
      if (isMissingColumnError(err)) continue;
      throw err;
    }
  }

  if (lastErr) throw lastErr;
  return null;
}

function dryRunSuccessResponse({ prequote, tenantId, finalPrice }) {
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
}

function createSuccessResponse({ quote, conversion, finalPrice }) {
  return json(200, {
    ok: true,
    dry_run: false,
    message: "Draft quote created. It was not sent, published, invoiced, or emailed.",
    draft_quote: {
      id: String(quote.id),
      status: String(quote.status || "DRAFT"),
      project_name: trimStr(quote.project_name, 500),
      client_name: trimStr(quote.client_name, 500),
      client_email: trimStr(quote.client_email, 320),
      estimated_amount: finalPrice,
    },
    conversion: {
      id: String(conversion.id),
      status: String(conversion.status || "draft_created"),
      ai_closer_prequote_id: String(conversion.ai_closer_prequote_id),
      official_quote_id: String(conversion.official_quote_id || quote.id),
    },
    side_effects: {
      created_quote_items: false,
      created_quote_labor: false,
      created_invoice: false,
      created_payment: false,
      published: false,
      emailed_client: false,
    },
  });
}

async function validateConversionRequest(body, tenantId) {
  const prequoteId = trimStr(body.prequote_id ?? body.prequoteId, 80);
  if (!prequoteId || !UUID_RE.test(prequoteId)) {
    return { error: json(400, { ok: false, error: "Valid prequote_id is required" }) };
  }

  const finalPrice = parsePositivePrice(body.final_price_owner_approved);
  if (finalPrice == null) {
    return {
      error: json(400, {
        ok: false,
        error: "final_price_owner_approved must be a number greater than zero",
      }),
    };
  }

  if (!confirmationsValid(body.owner_confirmations)) {
    return {
      error: json(400, {
        ok: false,
        error: "All owner confirmations are required and must be true",
      }),
    };
  }

  let prequote;
  try {
    prequote = await readPrequote(prequoteId, tenantId);
  } catch (_err) {
    return { error: json(502, { ok: false, error: "Unable to load pre-quote" }) };
  }

  if (!prequote?.id) {
    return { error: json(404, { ok: false, error: "Pre-quote not found" }) };
  }

  const prequoteStatus = String(prequote.status || "").toLowerCase();
  if (!ELIGIBLE_PREQUOTE_STATUSES.has(prequoteStatus)) {
    return {
      error: json(409, {
        ok: false,
        error: "Pre-quote status is not eligible for draft quote conversion",
      }),
    };
  }

  let existingConversion;
  try {
    existingConversion = await readExistingConversion(prequoteId, tenantId);
  } catch (_err) {
    return { error: json(502, { ok: false, error: "Unable to check conversion status" }) };
  }

  if (existingConversion?.id) {
    return {
      error: json(409, {
        ok: false,
        error:
          "A conversion record already exists for this pre-quote. No draft quote was created.",
      }),
    };
  }

  return {
    prequoteId,
    finalPrice,
    prequote,
    startDate: normIsoDate(body.start_date ?? body.startDate),
    ownerNote: body.owner_note ?? body.ownerNote,
  };
}

async function handleDryRun(validated, tenantId) {
  return dryRunSuccessResponse({
    prequote: validated.prequote,
    tenantId,
    finalPrice: validated.finalPrice,
  });
}

async function handleCreateDraft(validated, tenantId, createdBy) {
  const { prequoteId, finalPrice, prequote, startDate, ownerNote } = validated;
  const metadata = buildConversionMetadata({ finalPrice, startDate, ownerNote });

  let conversion;
  try {
    conversion = await insertConversionRow({
      tenantId,
      prequoteId,
      createdBy,
      metadata,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return json(409, {
        ok: false,
        error:
          "A conversion record already exists for this pre-quote. No draft quote was created.",
      });
    }
    return json(502, { ok: false, error: "Unable to start draft quote conversion" });
  }

  if (!conversion?.id) {
    return json(502, { ok: false, error: "Unable to start draft quote conversion" });
  }

  const conversionId = String(conversion.id);
  const quotePayload = buildQuoteInsertPayload({
    tenantId,
    prequote,
    finalPrice,
    startDate,
    ownerNote,
  });

  let quote;
  try {
    quote = await insertDraftQuote(quotePayload);
  } catch (_err) {
    await markConversionFailed(conversionId);
    return json(502, { ok: false, error: "Unable to create draft quote" });
  }

  if (!quote?.id || String(quote.tenant_id || "") !== tenantId) {
    await markConversionFailed(conversionId);
    return json(502, { ok: false, error: "Unable to create draft quote" });
  }

  let finalizedConversion;
  try {
    finalizedConversion = await finalizeConversionRow(conversionId, String(quote.id));
  } catch (_err) {
    await markConversionFailed(conversionId);
    return json(502, { ok: false, error: "Draft quote created but conversion record update failed" });
  }

  return createSuccessResponse({
    quote,
    conversion: finalizedConversion || {
      ...conversion,
      official_quote_id: quote.id,
      status: "draft_created",
    },
    finalPrice,
  });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const { tenantId, createdBy } = await resolveOwnerAdminContext(event);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const isDryRun = body.dry_run === true;
    const isCreate = body.create_draft_quote === true;

    if (!isDryRun) {
      if (!isCreate) {
        return json(400, {
          ok: false,
          error:
            "Explicit create_draft_quote: true is required when dry_run is false.",
        });
      }
    }

    const validated = await validateConversionRequest(body, tenantId);
    if (validated.error) return validated.error;

    if (isDryRun) {
      return handleDryRun(validated, tenantId);
    }

    return handleCreateDraft(validated, tenantId, createdBy);
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, { ok: false, error: err.message || "Forbidden" });
    }
    return json(500, { ok: false, error: "Server error" });
  }
};
