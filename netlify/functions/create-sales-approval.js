const crypto = require("crypto");
const fetch = globalThis.fetch;
const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { marginLevelForSalesApproval } = require("./_lib/pricing-engine");

const MAX_RAW_BODY_LOG = 8000;
const MAX_INSERT_LOG = 12000;

/** DEBUG: always HTTP 200 + JSON so the browser never loses error bodies (remove after fixing 502s). */
function ok200(bodyObj) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj)
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

/** PostgREST may return one row as an object or as a one-element array. */
function firstRowFromSupabase(data) {
  if (Array.isArray(data)) {
    return data.length ? data[0] : null;
  }
  if (data && typeof data === "object" && data.id != null) {
    return data;
  }
  return null;
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
      console.warn("[create-sales-approval] Zapier webhook non-OK", r.status, t?.slice(0, 500));
      return { ok: false, reason: "http_error", status: r.status, bodyPreview: t?.slice(0, 300) };
    }
    return { ok: true };
  } catch (err) {
    console.warn("[create-sales-approval] Zapier fetch error", err?.message || err);
    return { ok: false, reason: "fetch_error", fetchMessage: err?.message };
  }
}

exports.handler = async (event) => {
  try {
    console.log("[create-sales-approval] handler entered", {
      method: event.httpMethod,
      isBase64Encoded: Boolean(event.isBase64Encoded)
    });

    if (event.httpMethod !== "POST") {
      return ok200({ ok: false, stage: "method", error: "Method Not Allowed" });
    }

    let rawBody = "";
    try {
      rawBody =
        event.isBase64Encoded && event.body
          ? Buffer.from(event.body, "base64").toString("utf8")
          : String(event.body || "");
    } catch (decodeErr) {
      console.error("CREATE SALES APPROVAL ERROR (raw body):", decodeErr);
      return ok200({
        ok: false,
        stage: "raw_body_decode",
        error: decodeErr?.message || String(decodeErr),
        stack: decodeErr?.stack || null
      });
    }

    console.log("[create-sales-approval] request body (raw)", {
      byteLength: Buffer.byteLength(rawBody, "utf8"),
      body: rawBody.slice(0, MAX_RAW_BODY_LOG)
    });

    let body = {};
    try {
      body = JSON.parse(rawBody || "{}");
    } catch (parseErr) {
      console.error("CREATE SALES APPROVAL ERROR (JSON parse):", parseErr);
      return ok200({
        ok: false,
        stage: "parse_json",
        error: parseErr?.message || String(parseErr),
        stack: parseErr?.stack || null
      });
    }

    console.log("[create-sales-approval] parsed body summary", {
      keys: Object.keys(body || {}),
      project_name: body?.project_name ?? body?.projectName,
      offered_price: body?.offered_price ?? body?.offeredPrice ?? body?.price,
      workersLen: Array.isArray(body?.workers) ? body.workers.length : null
    });

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      console.warn("[create-sales-approval] unauthorized: missing session e/c");
      return ok200({ ok: false, stage: "session", error: "Unauthorized" });
    }

    let tenant;
    try {
      tenant = await resolveTenantFromSession(session);
    } catch (tenantErr) {
      console.error("CREATE SALES APPROVAL ERROR (tenant):", tenantErr);
      return ok200({
        ok: false,
        stage: "tenant_resolve",
        error: tenantErr?.message || String(tenantErr),
        stack: tenantErr?.stack || null,
        supabaseRawPreview: tenantErr?.supabaseRaw?.slice?.(0, 800)
      });
    }
    if (!tenant?.id) {
      console.warn("[create-sales-approval] no tenant for session");
      return ok200({
        ok: false,
        stage: "tenant_missing",
        error:
          "Cannot create approval: missing tenant for this account. Run bootstrap-tenant before continuing."
      });
    }
    console.log("[create-sales-approval] tenant resolved", { tenant_id: tenant.id });

    const normalized = normalizeApprovalPayload(body);
    if (!normalized.ok) {
      console.warn("[create-sales-approval] normalize failed", normalized.error);
      return ok200({ ok: false, stage: "normalize", error: normalized.error });
    }

    const quoteIds = {
      project_name: normalized.row.project_name,
      estimate_number: pickFirst(body, ["estimate_number", "estimateNumber", "estimate_no"]),
      quote_id: pickFirst(body, ["quote_id", "quoteId", "public_quote_id"]),
      client_name: normalized.row.client_name
    };
    console.log("[create-sales-approval] quote/project ids", quoteIds);

    let tenantSettings = {};
    let gate;
    try {
      try {
        tenantSettings = await loadTenantSettingsFromLatestSnapshot(tenant.id);
      } catch (snapErr) {
        console.warn("[create-sales-approval] snapshot load failed (continuing with {})", snapErr?.message);
      }
      const marginResult = marginLevelForSalesApproval(
        {
          workers: normalized.row.workers,
          offered_price: normalized.row.offered_price
        },
        tenantSettings
      );
      gate = marginResult.gate;
      console.log("[create-sales-approval] metrics / gate", {
        level: gate.level,
        realMarginPct: gate.realMarginPct,
        profitPct: gate.profitPct,
        minimumMarginPct: gate.minimumMarginPct
      });
    } catch (gateErr) {
      console.error("CREATE SALES APPROVAL ERROR (margin gate):", gateErr);
      return ok200({
        ok: false,
        stage: "margin_gate",
        error: gateErr?.message || String(gateErr),
        stack: gateErr?.stack || null
      });
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
      created_at
    };

    let insertPayloadLog;
    try {
      insertPayloadLog = JSON.stringify(insertPayload);
    } catch (_e) {
      insertPayloadLog = "(insertPayload not JSON-serializable)";
    }
    console.log("[create-sales-approval] insert payload", insertPayloadLog.slice(0, MAX_INSERT_LOG));

    let rows;
    try {
      rows = await supabaseRequest("sales_approvals", {
        method: "POST",
        body: insertPayload
      });
    } catch (insertErr) {
      console.error("CREATE SALES APPROVAL ERROR (Supabase insert):", insertErr);
      return ok200({
        ok: false,
        stage: "supabase_insert",
        error: insertErr?.message || String(insertErr),
        stack: insertErr?.stack || null,
        supabaseStatus: insertErr?.status,
        supabaseRawPreview: insertErr?.supabaseRaw?.slice?.(0, 1200)
      });
    }

    let rowsLog;
    try {
      rowsLog = JSON.stringify(rows);
    } catch (_e) {
      rowsLog = String(rows);
    }
    console.log("[create-sales-approval] Supabase insert response", rowsLog.slice(0, MAX_INSERT_LOG));

    const row = firstRowFromSupabase(rows);
    const approval_id = row?.id ?? null;
    if (!approval_id) {
      const preview =
        typeof rows === "string" ? rows.slice(0, 500) : JSON.stringify(rows)?.slice(0, 800);
      console.error("[create-sales-approval] no approval id after insert", preview);
      return ok200({
        ok: false,
        stage: "insert_no_id",
        error: "Approval was not persisted (no id returned).",
        responsePreview: preview
      });
    }
    console.log("[create-sales-approval] insert success", { approval_id });

    if (requested_by_email) {
      try {
        await supabaseRequest(`sales_approvals?id=eq.${encodeURIComponent(String(approval_id))}`, {
          method: "PATCH",
          body: { requested_by_email }
        });
        console.log("[create-sales-approval] PATCH requested_by_email OK");
      } catch (patchMetaErr) {
        console.warn(
          "[create-sales-approval] PATCH requested_by_email skipped",
          patchMetaErr?.message || patchMetaErr
        );
      }
    }

    /** @type {{ token?: string; project_name?: string; seller_name?: string; real_margin_pct?: number|null; zapier_webhook_ok?: boolean }} */
    const yellowResponse = {};

    try {
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
          console.log("[create-sales-approval] token hash PATCH OK");
        } catch (patchErr) {
          console.error("CREATE SALES APPROVAL ERROR (token PATCH, non-fatal):", patchErr);
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
          const zapierWebhookResult = await postZapierSalesApprovalWebhook(hookUrl, zapierPayload);
          yellowResponse.zapier_webhook_ok = Boolean(zapierWebhookResult?.ok);
          console.log("[create-sales-approval] Zapier webhook result", zapierWebhookResult);
        } else if (tokenStored && !hookUrl) {
          yellowResponse.zapier_webhook_ok = false;
        }
      }
    } catch (flowErr) {
      console.error("CREATE SALES APPROVAL ERROR (yellow / Zapier flow, non-fatal):", flowErr);
    }

    return ok200({
      ok: true,
      approval_id,
      ...yellowResponse
    });
  } catch (err) {
    console.error("CREATE SALES APPROVAL ERROR:", err);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: err?.message || "unknown error",
        stack: err?.stack || null
      })
    };
  }
};
