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

function normalizeDepositStripeLink(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const value = String(raw).trim();
  if (!value.toLowerCase().startsWith("https://buy.stripe.com/")) {
    return {
      error:
        "deposit_payment_link must be empty or start with https://buy.stripe.com/",
    };
  }
  return { value };
}

function normalizePaymentInstructions(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().slice(0, 8000);
  return s ? s : null;
}

function normalizePublicPaymentLink(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const u = String(raw).trim().slice(0, 2000);
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return { error: "payment_link must be a valid http(s) URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "payment_link must use http or https" };
  }
  return { value: u };
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
      let rows;
      try {
        rows = await supabaseRequest(
          `owner_settings?tenant_id=eq.${encodeURIComponent(tenantId)}&select=deposit_payment_link,payment_instructions,payment_link&limit=1`
        );
      } catch (err) {
        const msg = String(err?.message || "");
        const missingCol = /payment_instructions|payment_link|column/i.test(msg);
        if (!missingCol) throw err;
        rows = await supabaseRequest(
          `owner_settings?tenant_id=eq.${encodeURIComponent(tenantId)}&select=deposit_payment_link&limit=1`
        );
      }
      const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
      return json(200, {
        ok: true,
        deposit_payment_link: row?.deposit_payment_link ?? null,
        payment_instructions: row?.payment_instructions != null ? String(row.payment_instructions) : "",
        payment_link: row?.payment_link != null ? String(row.payment_link) : "",
      });
    }

    if (event.httpMethod === "POST" || event.httpMethod === "PATCH") {
      let body = {};
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "Invalid JSON" });
      }

      const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
      const patch = {};

      if (has("deposit_payment_link")) {
        const raw = body.deposit_payment_link;
        let value = null;
        if (raw != null && String(raw).trim() !== "") {
          const norm = normalizeDepositStripeLink(raw);
          if (norm.error) return json(400, { error: norm.error });
          value = norm.value;
        }
        patch.deposit_payment_link = value;
      }

      if (has("payment_instructions")) {
        patch.payment_instructions = normalizePaymentInstructions(body.payment_instructions);
      }

      if (has("payment_link")) {
        const norm = normalizePublicPaymentLink(body.payment_link);
        if (norm.error) return json(400, { error: norm.error });
        patch.payment_link = norm.value;
      }

      if (Object.keys(patch).length === 0) {
        return json(400, { error: "No fields to update" });
      }

      const existingRows = await supabaseRequest(
        `owner_settings?tenant_id=eq.${encodeURIComponent(tenantId)}&select=id&limit=1`
      );
      const existing = Array.isArray(existingRows) && existingRows[0] ? existingRows[0] : null;

      if (existing?.id) {
        await supabaseRequest(`owner_settings?id=eq.${encodeURIComponent(String(existing.id))}`, {
          method: "PATCH",
          body: patch,
        });
      } else {
        await supabaseRequest("owner_settings", {
          method: "POST",
          body: { tenant_id: tenantId, ...patch },
        });
      }

      let outRows;
      try {
        outRows = await supabaseRequest(
          `owner_settings?tenant_id=eq.${encodeURIComponent(tenantId)}&select=deposit_payment_link,payment_instructions,payment_link&limit=1`
        );
      } catch (_err) {
        outRows = await supabaseRequest(
          `owner_settings?tenant_id=eq.${encodeURIComponent(tenantId)}&select=deposit_payment_link&limit=1`
        );
      }
      const out = Array.isArray(outRows) && outRows[0] ? outRows[0] : null;

      return json(200, {
        ok: true,
        deposit_payment_link: out?.deposit_payment_link ?? null,
        payment_instructions: out?.payment_instructions != null ? String(out.payment_instructions) : "",
        payment_link: out?.payment_link != null ? String(out.payment_link) : "",
      });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
