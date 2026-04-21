const crypto = require("crypto");
const fetch = globalThis.fetch;
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { marginLevelForSalesApproval } = require("./_lib/pricing-engine");

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

async function loadTenantSettingsFromLatestSnapshot(tenantId) {
  const rows = await supabaseRequest(
    `tenant_snapshots?tenant_id=eq.${encodeURIComponent(String(tenantId))}&select=payload&order=created_at.desc&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  const payload = row?.payload;
  const storage =
    payload?.storage && typeof payload.storage === "object" ? payload.storage : {};
  const mg = storage["mg_settings_v2"];
  return mg && typeof mg === "object" ? mg : {};
}

function approvalActionBaseUrl(event) {
  const explicit = String(process.env.PUBLIC_SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (explicit) return explicit;
  const host = String(
    event.headers["x-forwarded-host"] ||
      event.headers["X-Forwarded-Host"] ||
      event.headers.host ||
      ""
  )
    .split(",")[0]
    .trim();
  const proto = String(
    event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"] || "https"
  )
    .split(",")[0]
    .trim() || "https";
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function hashTokenPlain(plain) {
  return crypto.createHash("sha256").update(String(plain), "utf8").digest("hex");
}

function randomUrlToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function zapierWebhookUrl() {
  return String(
    process.env.SALES_APPROVAL_ZAPIER_WEBHOOK_URL ||
      process.env.ZAPIER_SALES_APPROVAL_WEBHOOK_URL ||
      ""
  ).trim();
}

/**
 * POST JSON to Zapier Catch Hook (or compatible). Does not throw.
 */
async function postZapierSalesApprovalWebhook(url, payload) {
  const u = String(url || "").trim();
  if (!u.startsWith("https://") && !u.startsWith("http://")) {
    return { ok: false, reason: "invalid_webhook_url" };
  }
  try {
    const r = await fetch(u, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text();
      console.warn("[create-sales-approval] Zapier webhook non-OK", r.status, t?.slice(0, 300));
      return { ok: false, reason: "http_error", status: r.status };
    }
    return { ok: true };
  } catch (err) {
    console.warn("[create-sales-approval] Zapier webhook failed", err?.message || err);
    return { ok: false, reason: "fetch_error" };
  }
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
    const requested_by_email = String(session?.e || "").trim();
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
      created_at,
      requested_by_email
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

    /** @type {{ token?: string; project_name?: string; seller_name?: string; real_margin_pct?: number|null; zapier_webhook_ok?: boolean }} */
    const yellowResponse = {};
    let zapierWebhookResult = null;

    try {
      const tenantSettings = await loadTenantSettingsFromLatestSnapshot(tenant.id);
      const { gate } = marginLevelForSalesApproval(
        {
          workers: normalized.row.workers,
          offered_price: normalized.row.offered_price
        },
        tenantSettings
      );

      if (gate.level === "yellow") {
        const token = randomUrlToken();
        const email_action_token_hash = hashTokenPlain(token);

        let tokenStored = false;
        try {
          await supabaseRequest(`sales_approvals?id=eq.${encodeURIComponent(String(approval_id))}`, {
            method: "PATCH",
            body: { email_action_token_hash }
          });
          tokenStored = true;
        } catch (patchErr) {
          console.error("[create-sales-approval] token PATCH failed", patchErr?.message || patchErr);
        }

        const base = approvalActionBaseUrl(event);
        const fnPath = "/.netlify/functions/sales-approval-email-action";
        const approveUrl = tokenStored && base
          ? `${base}${fnPath}?id=${encodeURIComponent(String(approval_id))}&action=approve&t=${encodeURIComponent(token)}`
          : "";
        const declineUrl = tokenStored && base
          ? `${base}${fnPath}?id=${encodeURIComponent(String(approval_id))}&action=decline&t=${encodeURIComponent(token)}`
          : "";

        const real_margin_pct =
          gate.realMarginPct != null && Number.isFinite(gate.realMarginPct)
            ? Math.round(gate.realMarginPct * 1000) / 1000
            : null;

        const seller_name = requested_by_email || "";

        if (tokenStored) {
          yellowResponse.token = token;
          yellowResponse.project_name = normalized.row.project_name || "";
          yellowResponse.seller_name = seller_name;
          yellowResponse.real_margin_pct = real_margin_pct;
        }

        const hookUrl = zapierWebhookUrl();
        if (tokenStored && hookUrl) {
          const zapierPayload = {
            approval_id: String(approval_id),
            token,
            project_name: normalized.row.project_name || "",
            seller_name,
            seller_email: seller_name,
            real_margin_pct,
            target_margin_pct: gate.profitPct,
            minimum_margin_pct: gate.minimumMarginPct,
            final_price: normalized.row.offered_price,
            tenant_id: String(tenant.id),
            approve_url: approveUrl || undefined,
            decline_url: declineUrl || undefined
          };
          zapierWebhookResult = await postZapierSalesApprovalWebhook(hookUrl, zapierPayload);
          yellowResponse.zapier_webhook_ok = Boolean(zapierWebhookResult?.ok);
        } else if (tokenStored && !hookUrl) {
          yellowResponse.zapier_webhook_ok = false;
        }
      }
    } catch (flowErr) {
      console.error("[create-sales-approval] yellow / Zapier flow", flowErr?.message || flowErr);
    }

    return json(200, {
      ok: true,
      approval_id,
      ...yellowResponse
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
