/**
 * Owner-only: soft-archive an orphan quote (status update only; no row delete).
 * Step 3E-C9-C5-E1 — quote-only READY_TO_SEND cleanup without invoice/project flows.
 * Step 3E-C9-C9-D — optional estimate-number + project_name lookup when quote_id is absent.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUOTE_ARCHIVE_SELECT =
  "id,tenant_id,status,accepted_at,project_name,title,updated_at";

const BLOCKED_QUOTE_STATUSES = new Set(["accepted", "approved"]);
const ARCHIVED_STATUS = "archived";
/** Invoice statuses that do not block quote-only archive (terminal / already archived). */
const SAFELY_ARCHIVABLE_INVOICE_STATUSES = new Set(["archived", "void"]);

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

function normStatus(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function pickQuoteLabel(quote) {
  const projectName = String(quote?.project_name || "").trim();
  if (projectName) return projectName;
  return String(quote?.title || "").trim();
}

function serializeQuoteSummary(quote, previousStatus, updatedAt, extra) {
  return {
    id: quote.id,
    tenant_id: quote.tenant_id,
    project_name: pickQuoteLabel(quote),
    status: ARCHIVED_STATUS,
    previous_status: previousStatus,
    updated_at: updatedAt,
    ...extra,
  };
}

async function fetchQuoteForTenant(tenantId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const qid = encodeURIComponent(quoteId);
  const rows = await supabaseRequest(
    `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=${QUOTE_ARCHIVE_SELECT}&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchQuotesByDisplayAndProject(tenantId, quoteNumberDisplay, projectName) {
  const tid = encodeURIComponent(tenantId);
  const displayEnc = encodeURIComponent(quoteNumberDisplay);
  const projectEnc = encodeURIComponent(projectName);
  const rows = await supabaseRequest(
    `quotes?tenant_id=eq.${tid}&quote_number_display=eq.${displayEnc}&project_name=eq.${projectEnc}&select=${QUOTE_ARCHIVE_SELECT}&limit=2`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows : [];
}

async function hasTenantProjectForQuote(tenantId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const qid = encodeURIComponent(quoteId);
  const rows = await supabaseRequest(
    `tenant_projects?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=id&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows.length > 0 && Boolean(rows[0]?.id);
}

async function findBlockingInvoiceForQuote(tenantId, quoteId) {
  const tid = encodeURIComponent(tenantId);
  const qid = encodeURIComponent(quoteId);
  const rows = await supabaseRequest(
    `invoices?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=id,status&limit=20`,
    { method: "GET" }
  );
  const list = Array.isArray(rows) ? rows : [];
  for (const inv of list) {
    if (!inv?.id) continue;
    const st = normStatus(inv.status);
    if (!SAFELY_ARCHIVABLE_INVOICE_STATUSES.has(st)) {
      return inv;
    }
  }
  return null;
}

async function archiveResolvedQuote(tenantId, quoteId, quote) {
  const previousStatus = quote.status == null ? "" : String(quote.status);
  const statusNorm = normStatus(previousStatus);

  if (statusNorm === ARCHIVED_STATUS) {
    const updatedAt = String(quote.updated_at || "").trim() || new Date().toISOString();
    return json(200, {
      ok: true,
      already_archived: true,
      quote: serializeQuoteSummary(quote, previousStatus, updatedAt),
    });
  }

  if (BLOCKED_QUOTE_STATUSES.has(statusNorm)) {
    return json(422, {
      error: "Cannot archive an accepted or approved quote.",
      code: "quote_accepted",
    });
  }

  if (String(quote.accepted_at || "").trim()) {
    return json(422, {
      error: "Cannot archive a quote with accepted_at set.",
      code: "quote_accepted",
    });
  }

  if (await hasTenantProjectForQuote(tenantId, quoteId)) {
    return json(422, {
      error: "Cannot archive a quote linked to a tenant project.",
      code: "quote_has_project",
    });
  }

  const blockingInvoice = await findBlockingInvoiceForQuote(tenantId, quoteId);
  if (blockingInvoice?.id) {
    return json(422, {
      error: "Cannot archive quote while a non-archivable invoice exists.",
      code: "quote_has_active_invoice",
    });
  }

  const nowIso = new Date().toISOString();
  const tidEnc = encodeURIComponent(tenantId);
  const qidEnc = encodeURIComponent(quoteId);

  await supabaseRequest(`quotes?id=eq.${qidEnc}&tenant_id=eq.${tidEnc}`, {
    method: "PATCH",
    body: { status: ARCHIVED_STATUS, updated_at: nowIso },
  });

  return json(200, {
    ok: true,
    already_archived: false,
    quote: serializeQuoteSummary(quote, previousStatus, nowIso),
  });
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

    const quoteIdRaw = String(body.quote_id || body.quoteId || "").trim();
    const action = String(body.action || "").trim().toLowerCase();

    if (action !== "archive") {
      return json(400, { error: 'action must be "archive"', code: "invalid_action" });
    }

    const tenantId = String(ctx.tenant.id);
    let quote = null;
    let quoteId = "";

    if (quoteIdRaw && UUID_RE.test(quoteIdRaw)) {
      quoteId = quoteIdRaw;
      quote = await fetchQuoteForTenant(tenantId, quoteId);
    } else if (quoteIdRaw) {
      return json(400, { error: "Valid quote_id is required", code: "invalid_quote_id" });
    } else {
      const quoteNumberDisplay = String(
        body.quote_number_display || body.estimate_number || ""
      ).trim();
      const projectName = String(body.project_name || body.projectName || "").trim();

      if (!quoteNumberDisplay || !projectName) {
        return json(400, {
          error:
            "quote_number_display (or estimate_number) and project_name are required when quote_id is omitted.",
          code: "missing_lookup_fields",
        });
      }

      const matches = await fetchQuotesByDisplayAndProject(
        tenantId,
        quoteNumberDisplay,
        projectName
      );

      if (matches.length === 0) {
        return json(404, { error: "Quote not found", code: "quote_not_found" });
      }
      if (matches.length > 1) {
        return json(409, {
          error: "Multiple quotes matched the lookup fields.",
          code: "ambiguous_quote_match",
        });
      }

      quote = matches[0];
      quoteId = String(quote.id || "").trim();
    }

    if (!quote?.id || !quoteId) {
      return json(404, { error: "Quote not found", code: "quote_not_found" });
    }

    return archiveResolvedQuote(tenantId, quoteId, quote);
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    console.error("[archive-tenant-quote]", err);
    return json(500, { error: err.message || "Unexpected error" });
  }
};
