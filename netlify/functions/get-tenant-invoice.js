const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

/**
 * GET — one invoice for the signed-in tenant.
 * Query: id=<uuid> OR public_token=<token> (exactly one required).
 * Every query includes tenant_id=eq.<resolved tenant>.
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
        error: "Cannot load invoice: tenant not found for this session. Run bootstrap-tenant first."
      });
    }

    const tenantId = String(tenant.id);
    const qs = event.queryStringParameters || {};
    const id = String(qs.id || "").trim();
    const publicToken = String(qs.public_token || qs.publicToken || "").trim();

    if (id && publicToken) {
      return json(400, { error: "Provide only one of id or public_token." });
    }
    if (!id && !publicToken) {
      return json(400, { error: "Missing id or public_token." });
    }

    const params = new URLSearchParams();
    params.set("tenant_id", `eq.${tenantId}`);
    params.set("select", "*");
    params.set("limit", "2");

    if (id) {
      if (!UUID_RE.test(id)) {
        return json(400, { error: "Invalid id (expected UUID)." });
      }
      params.set("id", `eq.${id}`);
    } else {
      if (publicToken.length < 8 || publicToken.length > 256 || !/^[a-zA-Z0-9_]+$/.test(publicToken)) {
        return json(400, { error: "Invalid public_token." });
      }
      params.set("public_token", `eq.${publicToken}`);
    }

    const path = `invoices?${params.toString()}`;
    const rows = await supabaseRequest(path, { method: "GET" });
    const list = Array.isArray(rows) ? rows : [];

    if (list.length === 0) {
      return json(404, { error: "Invoice not found." });
    }
    if (list.length > 1) {
      return json(500, { error: "Ambiguous invoice reference." });
    }

    const invoice = list[0];
    if (String(invoice.tenant_id || "") !== tenantId) {
      return json(404, { error: "Invoice not found." });
    }

    return json(200, { ok: true, invoice });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
