const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const ALLOWED_STATUS = new Set(["draft", "issued", "sent", "partial", "paid", "overdue", "void"]);

function safeEqFilterValue(raw, label) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (label === "status" && !ALLOWED_STATUS.has(s)) {
    throw new Error(`Invalid status filter. Allowed: ${[...ALLOWED_STATUS].join(", ")}`);
  }
  if (label === "payment_status" && !/^[a-z0-9_-]{1,64}$/i.test(s)) {
    throw new Error("Invalid payment_status filter.");
  }
  return s;
}

/**
 * GET — list invoices for the signed-in tenant only.
 * Query: status, payment_status, limit (default 50, max 200).
 * Order: created_at desc
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method Not Allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(422, {
        error: "Cannot list invoices: tenant not found for this session. Run bootstrap-tenant first."
      });
    }

    const tenantId = String(tenant.id);
    const qs = event.queryStringParameters || {};
    let statusFilter = "";
    let paymentStatusFilter = "";
    try {
      statusFilter = qs.status ? safeEqFilterValue(qs.status, "status") : "";
      paymentStatusFilter = qs.payment_status || qs.paymentStatus
        ? safeEqFilterValue(qs.payment_status || qs.paymentStatus, "payment_status")
        : "";
    } catch (e) {
      return json(400, { error: e.message || "Invalid query" });
    }
    const limit = clampInt(qs.limit, 1, 200, 50);

    const params = new URLSearchParams();
    params.set("tenant_id", `eq.${tenantId}`);
    params.set("order", "created_at.desc");
    params.set("limit", String(limit));

    if (statusFilter) {
      params.set("status", `eq.${statusFilter}`);
    }
    if (paymentStatusFilter) {
      params.set("payment_status", `eq.${paymentStatusFilter}`);
    }

    const path = `invoices?${params.toString()}`;
    const rows = await supabaseRequest(path, { method: "GET" });
    let invoices = Array.isArray(rows) ? rows : [];
    if (!Array.isArray(invoices)) {
      invoices = [];
    }

    console.log("[list-tenant-invoices] returning:", invoices.length);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ok: true,
        invoices
      })
    };
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
