/**
 * Owner-only: read-only tenant quote list for Sales Admin Phase 2B.
 * Step 3E-C11-B2 — GET list-tenant-quotes (no writes, no public_token).
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { requireOwnerMembership } = require("./_lib/tenant-device-guard");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const QUOTE_LIST_SELECT = [
  "id",
  "quote_number_display",
  "quote_year",
  "quote_sequence",
  "project_name",
  "title",
  "client_name",
  "client_email",
  "status",
  "total",
  "deposit_required",
  "currency",
  "accepted_at",
  "created_at",
  "updated_at",
  "seller_membership_id",
  "seller_email",
  "created_by_role",
  "source_device_id",
].join(",");

const SUMMARY_SELECT =
  "id,status,created_at,seller_membership_id,created_by_role";

const ALLOWED_QUOTE_STATUS = new Set([
  "ready_to_send",
  "accepted",
  "approved",
  "archived",
  "declined",
  "draft",
  "sent",
  "pending",
  "rejected",
]);

const ALLOWED_CREATED_BY_ROLE = new Set(["owner", "seller"]);

const ALLOWED_SORT = new Set([
  "created_at_desc",
  "created_at_asc",
  "estimate_desc",
  "estimate_asc",
]);

const SUMMARY_ROW_CAP = 5000;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function normStatus(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function normRole(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function parseLimit(raw) {
  if (raw == null || raw === "") return { ok: true, value: 50 };
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1 || n > 200) return { ok: false };
  return { ok: true, value: n };
}

function parseOffset(raw) {
  if (raw == null || raw === "") return { ok: true, value: 0 };
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

function parseQuoteYear(raw) {
  if (raw == null || raw === "") return { ok: true, value: null };
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 2000 || n > 2100) return { ok: false };
  return { ok: true, value: n };
}

function parseHasProject(raw) {
  if (raw == null || raw === "") return { ok: true, value: null };
  const s = String(raw).trim().toLowerCase();
  if (s === "true") return { ok: true, value: true };
  if (s === "false") return { ok: true, value: false };
  return { ok: false };
}

/** UTC month bounds [startIso, endIso) for YYYY-MM filter. */
function utcMonthBounds(monthStr) {
  const [yStr, mStr] = monthStr.split("-");
  const y = Number(yStr);
  const m = Number(mStr) - 1;
  const start = new Date(Date.UTC(y, m, 1)).toISOString();
  const end = new Date(Date.UTC(y, m + 1, 1)).toISOString();
  return { start, end };
}

function currentUtcMonthBounds() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1)).toISOString(),
    end: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
  };
}

function escapeIlikeNeedle(raw) {
  return String(raw || "")
    .trim()
    .slice(0, 80)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function sortToOrder(sortKey) {
  switch (sortKey) {
    case "created_at_asc":
      return "created_at.asc";
    case "estimate_desc":
      return "quote_number_display.desc.nullslast,created_at.desc";
    case "estimate_asc":
      return "quote_number_display.asc.nullslast,created_at.desc";
    case "created_at_desc":
    default:
      return "created_at.desc";
  }
}

function toQuoteDto(row, projectQuoteIds) {
  const id = row?.id != null ? String(row.id).trim() : "";
  return {
    id: row.id,
    quote_number_display: row.quote_number_display ?? null,
    quote_year: row.quote_year ?? null,
    quote_sequence: row.quote_sequence ?? null,
    project_name: row.project_name ?? null,
    title: row.title ?? null,
    client_name: row.client_name ?? null,
    client_email: row.client_email ?? null,
    status: row.status ?? null,
    total: row.total ?? null,
    deposit_required: row.deposit_required ?? null,
    currency: row.currency ?? null,
    accepted_at: row.accepted_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    seller_membership_id: row.seller_membership_id ?? null,
    seller_email: row.seller_email ?? null,
    created_by_role: row.created_by_role ?? null,
    from_device: Boolean(row.source_device_id),
    has_tenant_project: id ? projectQuoteIds.has(id) : false,
  };
}

function isSellerAttributed(row) {
  if (row?.seller_membership_id) return true;
  return normRole(row?.created_by_role) === "seller";
}

function isOwnerCreated(row) {
  const role = normRole(row?.created_by_role);
  if (role === "seller") return false;
  if (role === "owner") return true;
  return !row?.seller_membership_id;
}

function computeSummaryFromRows(rows, publishedThisMonth) {
  let ready_to_send = 0;
  let accepted_or_approved = 0;
  let archived = 0;
  let seller_attributed = 0;
  let owner_created = 0;

  for (const row of rows) {
    const st = normStatus(row?.status);
    if (st === "ready_to_send") ready_to_send += 1;
    if (st === "accepted" || st === "approved") accepted_or_approved += 1;
    if (st === "archived") archived += 1;
    if (isSellerAttributed(row)) seller_attributed += 1;
    if (isOwnerCreated(row)) owner_created += 1;
  }

  return {
    published_this_month: publishedThisMonth,
    ready_to_send,
    accepted_or_approved,
    archived,
    seller_attributed,
    owner_created,
  };
}

async function loadProjectQuoteIdSet(tenantId) {
  const tid = encodeURIComponent(String(tenantId));
  const rows = await supabaseRequest(
    `tenant_projects?tenant_id=eq.${tid}&select=quote_id&quote_id=not.is.null`,
    { method: "GET" }
  );
  const set = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const qid = row?.quote_id != null ? String(row.quote_id).trim() : "";
    if (qid) set.add(qid);
  }
  return set;
}

function buildQuoteQueryParts(tenantId, filters) {
  const parts = [
    "quotes",
    "?tenant_id=eq." + encodeURIComponent(String(tenantId)),
  ];

  if (filters.status) {
    parts.push("&status=eq." + encodeURIComponent(filters.status));
  }
  if (filters.monthStart && filters.monthEnd) {
    parts.push("&created_at=gte." + encodeURIComponent(filters.monthStart));
    parts.push("&created_at=lt." + encodeURIComponent(filters.monthEnd));
  }
  if (filters.sellerMembershipId) {
    parts.push(
      "&seller_membership_id=eq." + encodeURIComponent(filters.sellerMembershipId)
    );
  }
  if (filters.createdByRole) {
    parts.push("&created_by_role=eq." + encodeURIComponent(filters.createdByRole));
  }
  if (filters.quoteYear != null) {
    parts.push("&quote_year=eq." + encodeURIComponent(String(filters.quoteYear)));
  }
  if (filters.projectNameNeedle) {
    parts.push(
      "&project_name=ilike.*" +
        encodeURIComponent(filters.projectNameNeedle) +
        "*"
    );
  }
  if (filters.quoteIdIn && filters.quoteIdIn.length > 0) {
    const inList = filters.quoteIdIn.map((id) => encodeURIComponent(id)).join(",");
    parts.push("&id=in.(" + inList + ")");
  } else if (filters.quoteIdIn && filters.quoteIdIn.length === 0) {
    parts.push("&id=eq.00000000-0000-4000-8000-000000000000");
  }
  if (filters.quoteIdNotIn && filters.quoteIdNotIn.length > 0) {
    const notList = filters.quoteIdNotIn.map((id) => encodeURIComponent(id)).join(",");
    parts.push("&id=not.in.(" + notList + ")");
  }

  return parts;
}

async function fetchQuotesForTenant(tenantId, filters, select, order, limit, offset) {
  const parts = buildQuoteQueryParts(tenantId, filters);
  parts.push("&select=" + select);
  parts.push("&order=" + order);
  if (limit != null) parts.push("&limit=" + String(limit));
  if (offset != null && offset > 0) parts.push("&offset=" + String(offset));
  const rows = await supabaseRequest(parts.join(""), { method: "GET" });
  return Array.isArray(rows) ? rows : [];
}

async function countPublishedThisMonth(tenantId) {
  const { start, end } = currentUtcMonthBounds();
  const tid = encodeURIComponent(String(tenantId));
  const rows = await supabaseRequest(
    `quotes?tenant_id=eq.${tid}&created_at=gte.${encodeURIComponent(start)}&created_at=lt.${encodeURIComponent(end)}&select=id`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows.length : 0;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed", code: "method_not_allowed" });
    }

    const ctx = await requireOwnerMembership(event);
    const tenantId = String(ctx.tenant.id);
    const qs = event.queryStringParameters || {};

    const limitParsed = parseLimit(qs.limit);
    if (!limitParsed.ok) {
      return json(400, { error: "limit must be between 1 and 200", code: "invalid_limit" });
    }
    const offsetParsed = parseOffset(qs.offset);
    if (!offsetParsed.ok) {
      return json(400, { error: "offset must be a non-negative integer", code: "invalid_offset" });
    }

    const statusFilter = qs.status ? normStatus(qs.status) : "";
    if (statusFilter && !ALLOWED_QUOTE_STATUS.has(statusFilter)) {
      return json(400, {
        error: "Invalid status filter",
        code: "invalid_status",
      });
    }

    let monthStart = "";
    let monthEnd = "";
    if (qs.month != null && String(qs.month).trim() !== "") {
      const monthStr = String(qs.month).trim();
      if (!MONTH_RE.test(monthStr)) {
        return json(400, {
          error: "month must be YYYY-MM",
          code: "invalid_month",
        });
      }
      const bounds = utcMonthBounds(monthStr);
      monthStart = bounds.start;
      monthEnd = bounds.end;
    }

    let sellerMembershipId = "";
    if (qs.seller_membership_id != null && String(qs.seller_membership_id).trim() !== "") {
      sellerMembershipId = String(qs.seller_membership_id).trim();
      if (!UUID_RE.test(sellerMembershipId)) {
        return json(400, {
          error: "seller_membership_id must be a valid UUID",
          code: "invalid_seller_membership_id",
        });
      }
    }

    const createdByRole = qs.created_by_role ? normRole(qs.created_by_role) : "";
    if (createdByRole && !ALLOWED_CREATED_BY_ROLE.has(createdByRole)) {
      return json(400, {
        error: "created_by_role must be owner or seller",
        code: "invalid_created_by_role",
      });
    }

    const quoteYearParsed = parseQuoteYear(qs.quote_year);
    if (!quoteYearParsed.ok) {
      return json(400, { error: "quote_year must be a valid year", code: "invalid_quote_year" });
    }

    const hasProjectParsed = parseHasProject(qs.has_project);
    if (!hasProjectParsed.ok) {
      return json(400, {
        error: "has_project must be true or false",
        code: "invalid_has_project",
      });
    }

    const projectNameNeedle = qs.project_name ? escapeIlikeNeedle(qs.project_name) : "";

    const sortKey = qs.sort ? String(qs.sort).trim().toLowerCase() : "created_at_desc";
    if (!ALLOWED_SORT.has(sortKey)) {
      return json(400, { error: "Invalid sort parameter", code: "invalid_sort" });
    }
    const order = sortToOrder(sortKey);

    const projectQuoteIds = await loadProjectQuoteIdSet(tenantId);

    const filters = {
      status: statusFilter,
      monthStart,
      monthEnd,
      sellerMembershipId,
      createdByRole,
      quoteYear: quoteYearParsed.value,
      projectNameNeedle,
      quoteIdIn: null,
      quoteIdNotIn: null,
    };

    if (hasProjectParsed.value === true) {
      filters.quoteIdIn = Array.from(projectQuoteIds);
    } else if (hasProjectParsed.value === false && projectQuoteIds.size > 0) {
      filters.quoteIdNotIn = Array.from(projectQuoteIds);
    }

    let rows;
    try {
      rows = await fetchQuotesForTenant(
        tenantId,
        filters,
        QUOTE_LIST_SELECT,
        order,
        limitParsed.value,
        offsetParsed.value
      );
    } catch (_err) {
      return json(500, { error: "Unable to load quotes", code: "quote_list_failed" });
    }

    const dtoQuotes = rows.map((row) => toQuoteDto(row, projectQuoteIds));

    let summaryRows;
    try {
      summaryRows = await fetchQuotesForTenant(
        tenantId,
        filters,
        SUMMARY_SELECT,
        "created_at.desc",
        SUMMARY_ROW_CAP + 1,
        0
      );
    } catch (_err) {
      return json(500, { error: "Unable to load quotes", code: "quote_list_failed" });
    }

    const summaryTruncated = summaryRows.length > SUMMARY_ROW_CAP;
    if (summaryTruncated) summaryRows = summaryRows.slice(0, SUMMARY_ROW_CAP);

    let publishedThisMonth;
    try {
      publishedThisMonth = await countPublishedThisMonth(tenantId);
    } catch (_err) {
      return json(500, { error: "Unable to load quotes", code: "quote_list_failed" });
    }

    const summary = computeSummaryFromRows(summaryRows, publishedThisMonth);
    if (summaryTruncated) {
      summary.truncated = true;
      summary.truncated_at = SUMMARY_ROW_CAP;
    }

    return json(200, {
      ok: true,
      quotes: dtoQuotes,
      summary,
      limit: limitParsed.value,
      offset: offsetParsed.value,
    });
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode, { error: err.message, code: err.code });
    }
    return json(500, { error: err.message || "Unexpected error", code: "quote_list_failed" });
  }
};
