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

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
          "Cannot update approval: missing tenant for this account. Run bootstrap-tenant before continuing."
      });
    }

    const body = parseBody(event.body);
    const rawId =
      body.approval_id !== undefined && body.approval_id !== null
        ? body.approval_id
        : body.id;
    const approvalId = String(rawId ?? "").trim();

    if (!approvalId || !UUID_RE.test(approvalId)) {
      return json(400, { error: "approval_id must be a valid UUID" });
    }

    const statusRaw = String(body.status ?? "").trim().toLowerCase();
    if (!["approved", "rejected"].includes(statusRaw)) {
      return json(400, { error: 'status must be "approved" or "rejected"' });
    }

    const nowIso = new Date().toISOString();
    const patch = {
      status: statusRaw,
      updated_at: nowIso
    };
    if (statusRaw === "approved") {
      patch.approved_at = nowIso;
    }

    const path = `sales_approvals?id=eq.${encodeURIComponent(approvalId)}&tenant_id=eq.${encodeURIComponent(String(tenant.id))}`;

    let rows;
    try {
      rows = await supabaseRequest(path, { method: "PATCH", body: patch });
    } catch (err) {
      return json(502, {
        error: err?.message || "Failed to update sales approval"
      });
    }

    const updated = Array.isArray(rows) ? rows[0] : null;
    if (!updated) {
      return json(404, {
        error: "Approval not found or access denied"
      });
    }

    return json(200, { ok: true, approval: updated });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
