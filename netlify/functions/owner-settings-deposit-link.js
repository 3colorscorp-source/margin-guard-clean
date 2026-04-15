const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found. Run bootstrap first." });
    }

    const tenantId = String(tenant.id);

    if (event.httpMethod === "GET") {
      const rows = await supabaseRequest(
        `owner_settings?tenant_id=eq.${encodeURIComponent(tenantId)}&select=deposit_payment_link&limit=1`
      );
      const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
      return json(200, {
        ok: true,
        deposit_payment_link: row?.deposit_payment_link ?? null,
      });
    }

    if (event.httpMethod === "POST" || event.httpMethod === "PATCH") {
      let body = {};
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "Invalid JSON" });
      }

      const raw = body.deposit_payment_link;
      let value = null;
      if (raw != null && String(raw).trim() !== "") {
        value = String(raw).trim();
        if (!value.toLowerCase().startsWith("https://buy.stripe.com/")) {
          return json(400, {
            error:
              "deposit_payment_link must be empty or start with https://buy.stripe.com/",
          });
        }
      }

      const existingRows = await supabaseRequest(
        `owner_settings?tenant_id=eq.${encodeURIComponent(tenantId)}&select=id&limit=1`
      );
      const existing = Array.isArray(existingRows) && existingRows[0] ? existingRows[0] : null;

      if (existing?.id) {
        await supabaseRequest(`owner_settings?id=eq.${encodeURIComponent(String(existing.id))}`, {
          method: "PATCH",
          body: { deposit_payment_link: value },
        });
      } else {
        await supabaseRequest("owner_settings", {
          method: "POST",
          body: { tenant_id: tenantId, deposit_payment_link: value },
        });
      }

      return json(200, { ok: true, deposit_payment_link: value });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
