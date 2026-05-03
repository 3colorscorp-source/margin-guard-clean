const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}
const crypto = require("crypto");

const { getSupabaseConfig } = require("./_lib/supabase-admin");
const { bridgeAcceptedQuoteToProjectAndInvoice } = require("./_lib/quote-accept-bridge");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function pickStr(v, maxLen) {
  const s = v == null || v === undefined ? "" : String(v).trim();
  if (!maxLen || maxLen < 1) return s;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function buildZapierSignatureMeta(payload) {
  console.log("[zapier-signature] building signature...");
  const secret = String(process.env.ZAPIER_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    console.log("[zapier-signature] secret missing; sending unsigned");
    return null;
  }
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const canonical = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(canonical)
    .digest("hex");
  return {
    signature,
    timestamp,
    nonce,
    version: "v1"
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    let supabaseUrl;
    let serviceRoleKey;
    try {
      ({ url: supabaseUrl, key: serviceRoleKey } = getSupabaseConfig());
    } catch (_e) {
      return json(500, { error: "Missing server configuration" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON" });
    }

    const rawToken = body.token;
    if (rawToken === undefined || rawToken === null) {
      return json(400, { error: "Missing token" });
    }
    const trimmed = String(rawToken).trim();
    if (trimmed === "") {
      return json(400, { error: "Missing token" });
    }
    if (trimmed.length < 10 || trimmed.length > 256) {
      return json(400, { error: "Invalid token" });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return json(400, { error: "Invalid token" });
    }

    const status = String(body.status || "").trim().toLowerCase();

    if (!["accepted", "declined"].includes(status)) {
      return json(400, { error: "Invalid status" });
    }

    const nowIso = new Date().toISOString();

    const patch = {
      status,
      updated_at: nowIso
    };

    if (status === "accepted") {
      patch.accepted_at = nowIso;
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/quotes?public_token=eq.${encodeURIComponent(trimmed)}&tenant_id=not.is.null`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "return=representation"
        },
        body: JSON.stringify(patch)
      }
    );

    const text = await response.text();

    if (!response.ok) {
      return json(502, {
        error: text || "Failed to update estimate status"
      });
    }

    let rows = [];
    try {
      rows = JSON.parse(text);
    } catch {
      rows = [];
    }

    const row = Array.isArray(rows) ? rows[0] : null;

    const rowAccepted =
      row &&
      typeof row === "object" &&
      String(row.status || "")
        .trim()
        .toLowerCase() === "accepted";

    if (status === "accepted" && rowAccepted) {
      try {
        await bridgeAcceptedQuoteToProjectAndInvoice(row);
      } catch (bridgeErr) {
        console.error("[accept-bridge] tenant_projects / invoices bridge failed", bridgeErr?.message || bridgeErr);
      }

      const acceptedWebhookUrl = String(process.env.ZAPIER_ESTIMATE_ACCEPTED_WEBHOOK_URL || "").trim();
      if (!acceptedWebhookUrl) {
        console.warn("[ZAPIER ACCEPTED WEBHOOK SKIPPED] missing webhook url");
      } else {
        try {
          const siteUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.SITE_URL || "")
            .trim()
            .replace(/\/+$/, "");
          const public_quote_url = siteUrl
            ? `${siteUrl}/estimate-public.html?token=${encodeURIComponent(trimmed)}`
            : "";

          const outbound = {
            event_type: "estimate_accepted",
            client_email: pickStr(row.client_email, 320),
            tenant_email: pickStr(row.business_email, 320),
            public_quote_url: pickStr(public_quote_url, 2000),
            business_name: pickStr(row.business_name, 300),
            to_name: pickStr(row.client_name, 200),
            quote_status: pickStr(row.status, 80),
            accepted_at: pickStr(row.accepted_at, 64),
            public_token: trimmed
          };

          const payload = { ...outbound };
          const signatureMeta = buildZapierSignatureMeta(payload);
          console.log("[zapier-signature] signature generated:", !!signatureMeta?.signature);
          if (signatureMeta) {
            payload.zapier_signature = signatureMeta.signature;
            payload.zapier_timestamp = signatureMeta.timestamp;
            payload.zapier_nonce = signatureMeta.nonce;
            payload.zapier_signature_version = signatureMeta.version;
          }

          console.log("[ZAPIER ACCEPTED WEBHOOK SEND] starting", { public_token: trimmed });
          const headers = { "Content-Type": "application/json" };
          if (signatureMeta) {
            headers["X-MG-Signature"] = signatureMeta.signature;
            headers["X-MG-Timestamp"] = signatureMeta.timestamp;
            headers["X-MG-Nonce"] = signatureMeta.nonce;
            headers["X-MG-Signature-Version"] = signatureMeta.version;
          }
          const res = await fetch(acceptedWebhookUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
          });
          console.log("[ZAPIER ACCEPTED WEBHOOK SEND] completed", { status: res.status });
          if (!res.ok) {
            console.warn("[ZAPIER ACCEPTED WEBHOOK] upstream non-OK", { status: res.status });
          }
        } catch (zErr) {
          console.error("[ZAPIER ACCEPTED WEBHOOK ERROR]", zErr);
        }
      }
    }

    return json(200, {
      ok: true,
      status,
      row
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
