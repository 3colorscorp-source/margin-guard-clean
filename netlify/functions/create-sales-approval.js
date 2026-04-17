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

function pickFirst(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return v;
    }
  }
  return undefined;
}

function finiteOrZero(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Maps client body fields to stored column names.
 */
function normalizeApprovalPayload(body) {
  const o = body && typeof body === "object" ? body : {};

  const project_name = String(
    pickFirst(o, ["project_name", "projectName", "project"]) ?? ""
  ).trim();

  const client_name = String(
    pickFirst(o, ["client_name", "clientName", "customer_name", "customerName"]) ?? ""
  ).trim();

  const client_email = String(
    pickFirst(o, ["client_email", "clientEmail", "customer_email", "customerEmail", "email"]) ?? ""
  ).trim();

  const offered_price = finiteOrZero(
    pickFirst(o, ["offered_price", "offeredPrice", "price", "offered"])
  );
  const recommended_price = finiteOrZero(
    pickFirst(o, ["recommended_price", "recommendedPrice", "recommended"])
  );
  const minimum_price = finiteOrZero(
    pickFirst(o, ["minimum_price", "minimumPrice", "minimum"])
  );

  let workers = o.workers;
  if (workers === undefined || workers === null) {
    workers = [];
  }
  if (!Array.isArray(workers)) {
    return { ok: false, error: "workers must be a JSON array" };
  }

  return {
    ok: true,
    row: {
      project_name,
      client_name,
      client_email,
      offered_price,
      recommended_price,
      minimum_price,
      workers
    }
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(422, {
        error:
          "Cannot create approval: missing tenant for this account. Run bootstrap-tenant before continuing."
      });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const normalized = normalizeApprovalPayload(body);
    if (!normalized.ok) {
      return json(400, { error: normalized.error });
    }

    const created_at = new Date().toISOString();
    const insertPayload = {
      tenant_id: tenant.id,
      project_name: normalized.row.project_name,
      client_name: normalized.row.client_name,
      client_email: normalized.row.client_email,
      offered_price: normalized.row.offered_price,
      recommended_price: normalized.row.recommended_price,
      minimum_price: normalized.row.minimum_price,
      workers: normalized.row.workers,
      status: "requested",
      created_at
    };

    let rows;
    try {
      rows = await supabaseRequest("sales_approvals", {
        method: "POST",
        body: insertPayload
      });
    } catch (err) {
      return json(502, {
        error: err?.message || "Failed to create sales approval"
      });
    }

    const row = Array.isArray(rows) ? rows[0] : null;
    const approval_id = row?.id ?? null;
    if (!approval_id) {
      return json(502, { error: "Approval was not persisted (no id returned)." });
    }

    return json(200, { ok: true, approval_id });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
