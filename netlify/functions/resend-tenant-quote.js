/**
 * Step 3E-C19-B — resend an unlocked edited quote via existing public link (owner/admin).
 * URL-only v1: no republish, no PDF, no status/total/token writes.
 */

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify's Node version to 18+.");
}

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
  evaluateQuoteEditGuard,
  buildPublicQuoteUrl,
} = require("./_lib/quote-edit-guard");

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

const ALLOWED_BODY_KEYS = new Set(["quote_id", "message_note"]);

const MESSAGE_NOTE_MAX = 500;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function parseBody(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
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

function trimMessageNote(raw) {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (!s) return "";
  if (s.length > MESSAGE_NOTE_MAX) {
    return { error: "message_note_too_long", max: MESSAGE_NOTE_MAX };
  }
  return s;
}

function isValidClientEmail(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  const at = s.indexOf("@");
  if (at < 1) return false;
  return s.indexOf(".", at + 1) > at;
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

async function fetchQuotePublicToken(tenantId, quoteId) {
  const tid = encodeURIComponent(String(tenantId));
  const qid = encodeURIComponent(String(quoteId));
  const rows = await supabaseRequest(
    `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=public_token&limit=1`,
    { method: "GET" }
  );
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  return row?.public_token != null ? String(row.public_token).trim() : "";
}

async function loadTenantZapierMeta(tenantId) {
  let tenantSlug = "";
  let businessName = "";
  let tenantEmail = "";
  try {
    const metaRows = await supabaseRequest(
      `tenants?id=eq.${encodeURIComponent(String(tenantId))}&select=slug,name,owner_email&limit=1`
    );
    const tr = Array.isArray(metaRows) && metaRows[0] ? metaRows[0] : null;
    if (tr) {
      tenantSlug = String(tr.slug ?? "").trim();
      businessName = String(tr.name ?? "").trim();
      tenantEmail = String(tr.owner_email ?? "").trim();
    }
  } catch (_e) {
    /* optional */
  }
  return { tenantSlug, businessName, tenantEmail };
}

function buildDefaultResendMessage({ clientName, publicUrl, messageNote }) {
  const name = String(clientName || "").trim() || "there";
  const lines = [
    `Hi ${name},`,
    "",
    "We updated your estimate as requested. Please review the corrected version here:",
    "",
    publicUrl,
    "",
  ];
  if (messageNote) {
    lines.push(messageNote, "");
  }
  return lines.join("\n").trim();
}

async function dispatchQuoteResendZapier({ tenantId, quote, publicUrl, messageNote, tenantMeta }) {
  const webhookUrl = pickFirst(
    process.env.ZAPIER_ESTIMATE_CTA_WEBHOOK_URL,
    process.env.ZAPIER_WEBHOOK_URL
  );

  if (!webhookUrl) {
    return { ok: false, code: "zapier_not_configured" };
  }

  const clientEmail = String(quote.client_email || "").trim();
  const clientName = pickFirst(quote.client_name);
  const projectName = pickFirst(quote.project_name, quote.title);
  const quoteNumber = pickFirst(quote.quote_number_display);
  const subject = quoteNumber ? `Updated estimate ${quoteNumber}` : "Updated estimate";

  const messageText = buildDefaultResendMessage({
    clientName,
    publicUrl,
    messageNote,
  });

  const zapierBody = {
    tenant_id: String(tenantId),
    tenant_slug: tenantMeta.tenantSlug,
    business_name: tenantMeta.businessName,
    to_name: clientName,
    client_name: clientName,
    client_email: clientEmail,
    project_name: projectName,
    quote_number_display: quoteNumber,
    subject,
    messageText,
    message_note: messageNote || "",
    public_quote_url: publicUrl,
    pdf_url: "",
    total: quote.total ?? null,
    currency: pickFirst(quote.currency, "USD"),
    event_type: "quote_resend",
    resend_reason: "owner_edited_quote",
    source: "owner_quote_resend",
  };

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(zapierBody),
    });
    if (resp.ok) {
      return { ok: true };
    }
    const errText = await resp.text().catch(() => "");
    console.warn("[resend-tenant-quote] Zapier HTTP error", resp.status, errText.slice(0, 400));
    return { ok: false, code: "zapier_send_failed", httpStatus: resp.status };
  } catch (err) {
    console.error("[resend-tenant-quote] Zapier network error", err?.message || err);
    return { ok: false, code: "zapier_send_failed", network: true };
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

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

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);

    const quoteId = pickFirst(body.quote_id);
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

    const noteRaw = trimMessageNote(body.message_note);
    if (noteRaw && typeof noteRaw === "object" && noteRaw.error === "message_note_too_long") {
      return json(400, {
        ok: false,
        error: `message_note must be at most ${MESSAGE_NOTE_MAX} characters`,
        code: "message_note_too_long",
      });
    }
    const messageNote = typeof noteRaw === "string" ? noteRaw : "";

    const guard = await evaluateQuoteEditGuard(tenantId, quoteId);

    if (guard.notFound) {
      return json(404, {
        ok: false,
        error: "Quote not found",
        code: "quote_not_found",
      });
    }

    if (guard.invalidQuoteId) {
      return json(400, {
        ok: false,
        error: "Invalid quote_id",
        code: "invalid_quote_id",
      });
    }

    if (guard.edit?.locked || !guard.edit?.is_editable) {
      return json(422, {
        ok: false,
        error: "Quote is locked and cannot be resent.",
        code: "quote_locked",
        lock_reasons: guard.edit?.lock_reasons || [],
      });
    }

    const quote = guard.quote || {};
    const clientEmail = String(quote.client_email || "").trim();
    if (!isValidClientEmail(clientEmail)) {
      return json(400, {
        ok: false,
        error: "Client email is required before resending the quote.",
        code: "client_email_required",
      });
    }

    const publicToken = await fetchQuotePublicToken(tenantId, quoteId);
    if (!publicToken) {
      return json(422, {
        ok: false,
        error: "Quote has no public link. Publish the quote before resending.",
        code: "public_link_missing",
      });
    }

    const publicUrl =
      pickFirst(quote.public_url) || pickFirst(buildPublicQuoteUrl(publicToken));
    if (!publicUrl) {
      return json(422, {
        ok: false,
        error: "Quote has no public link. Publish the quote before resending.",
        code: "public_link_missing",
      });
    }

    const tenantMeta = await loadTenantZapierMeta(tenantId);
    const dispatch = await dispatchQuoteResendZapier({
      tenantId,
      quote,
      publicUrl,
      messageNote,
      tenantMeta,
    });

    if (!dispatch.ok && dispatch.code === "zapier_not_configured") {
      return json(500, {
        ok: false,
        error: "Quote email webhook is not configured.",
        code: "zapier_not_configured",
      });
    }

    if (!dispatch.ok) {
      return json(502, {
        ok: false,
        error: "Unable to send updated quote email.",
        code: "zapier_send_failed",
      });
    }

    return json(200, {
      ok: true,
      quote_id: quoteId,
      quote_number_display: pickFirst(quote.quote_number_display) || null,
      public_url: publicUrl,
      sent_to: clientEmail,
      status: quote.status ?? null,
      message: "Updated quote resent to client.",
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("[resend-tenant-quote]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
