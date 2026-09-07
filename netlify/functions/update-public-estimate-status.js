const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}
const crypto = require("crypto");

const { getSupabaseConfig } = require("./_lib/supabase-admin");
const { bridgeAcceptedQuoteToProject, applyOperationalSnapshotForProject } = require("./_lib/quote-accept-bridge");
const {
  assertQuoteScheduleAvailable,
  tryAtomicAcceptQuoteReservingSchedule,
  revertQuoteAcceptance,
  scheduleConflictPayload,
  isScheduleConflictError,
  hasConfirmedReservation,
  reservationFailedPayload,
} = require("./_lib/schedule-accept-guard");
const { sanitizePublicQuoteRow } = require("./_lib/voice-operational-plan");

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

function quoteAlreadyAccepted(row) {
  if (!row || typeof row !== "object") return false;
  if (String(row.status || "").trim().toLowerCase() === "accepted") return true;
  return String(row.accepted_at || "").trim() !== "";
}

async function fetchQuoteByPublicToken(supabaseUrl, serviceRoleKey, publicToken) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/quotes?public_token=eq.${encodeURIComponent(publicToken)}&tenant_id=not.is.null&select=*&limit=2`,
    {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json"
      }
    }
  );
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(text || "Failed to load estimate");
    err.statusCode = 502;
    throw err;
  }
  let rows = [];
  try {
    rows = JSON.parse(text);
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows.length > 1) {
    const err = new Error("Invalid estimate reference");
    err.statusCode = 500;
    throw err;
  }
  return rows[0];
}

async function fetchTenantZapierWebhookSecret(supabaseUrl, serviceRoleKey, tenantId) {
  const tid = String(tenantId == null ? "" : tenantId).trim();
  if (!tid) return "";
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/tenants?id=eq.${encodeURIComponent(tid)}&select=zapier_webhook_secret&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Accept: "application/json"
        }
      }
    );
    const text = await res.text();
    if (!res.ok) return "";
    let rows = [];
    try {
      rows = JSON.parse(text);
    } catch {
      rows = [];
    }
    const trow = Array.isArray(rows) ? rows[0] : null;
    if (!trow || typeof trow !== "object") return "";
    const raw = trow.zapier_webhook_secret;
    const s = raw == null || raw === undefined ? "" : String(raw).trim();
    return s;
  } catch (_e) {
    return "";
  }
}

async function resolveZapierWebhookSecretForEstimate(supabaseUrl, serviceRoleKey, tenantId) {
  const fromTenant = await fetchTenantZapierWebhookSecret(supabaseUrl, serviceRoleKey, tenantId);
  if (fromTenant) return fromTenant;
  return String(process.env.ZAPIER_WEBHOOK_SECRET || "").trim();
}

function buildZapierSignatureMeta(payload, signedPayloadJson, resolvedSecret) {
  console.log("[zapier-signature] building signature...");
  const secret = String(resolvedSecret == null ? "" : resolvedSecret).trim();
  if (!secret) {
    console.log("[zapier-signature] secret missing; sending unsigned");
    return null;
  }
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const bodyJson = typeof signedPayloadJson === "string" ? signedPayloadJson : JSON.stringify(payload);
  const canonical = `${timestamp}.${nonce}.${bodyJson}`;
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

async function rollbackPatchedQuote(existingRow, revertFn) {
  const reverted = await revertFn(existingRow, existingRow.status);
  if (!reverted || reverted.ok !== true) {
    return json(503, reservationFailedPayload({
      needs_manual_repair: true,
      rollback_failed: true,
    }));
  }
  return null;
}

async function sendEstimateAcceptedWebhook({
  row,
  token,
  supabaseUrl,
  serviceRoleKey,
  fetchImpl,
}) {
  const acceptedWebhookUrl = String(process.env.ZAPIER_ESTIMATE_ACCEPTED_WEBHOOK_URL || "").trim();
  const webhook_url_exists = Boolean(acceptedWebhookUrl);
  console.log("[estimate-accepted-webhook] webhook_url_exists", webhook_url_exists);
  if (!acceptedWebhookUrl) {
    console.warn("[ZAPIER ACCEPTED WEBHOOK SKIPPED] missing webhook url");
    return { sent: false, skipped: true };
  }
  const fetchFn = fetchImpl || fetch;
  const trimmed = String(token || "").trim();
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

    const originalPayloadJson = JSON.stringify(outbound);
    const zapierSignedPayloadB64 = Buffer.from(originalPayloadJson, "utf8").toString("base64url");
    const zapierSecretForSigning = await resolveZapierWebhookSecretForEstimate(
      supabaseUrl,
      serviceRoleKey,
      row.tenant_id
    );
    const signatureMeta = buildZapierSignatureMeta({ ...outbound }, originalPayloadJson, zapierSecretForSigning);

    const zapierRequestBody = { ...outbound };
    if (signatureMeta) {
      zapierRequestBody.zapier_signature =
        zapierRequestBody.zapier_signature || String(signatureMeta.signature);
      zapierRequestBody.zapier_timestamp =
        zapierRequestBody.zapier_timestamp || String(signatureMeta.timestamp);
      zapierRequestBody.zapier_nonce = zapierRequestBody.zapier_nonce || String(signatureMeta.nonce);
      zapierRequestBody.zapier_signature_version =
        zapierRequestBody.zapier_signature_version || "v1";
    }
    zapierRequestBody.zapier_signed_payload_b64 = zapierSignedPayloadB64;

    const DBG = "[estimate-accepted-webhook-hmac-debug]";
    console.log(DBG, "object_keys_unsigned", Object.keys(outbound));
    console.log(DBG, "json_stringify_unsigned_payload", originalPayloadJson);
    if (signatureMeta) {
      const signing_canonical = `${signatureMeta.timestamp}.${signatureMeta.nonce}.${originalPayloadJson}`;
      console.log(DBG, "signing_canonical", signing_canonical);
      console.log(DBG, "zapier_timestamp", signatureMeta.timestamp);
      console.log(DBG, "zapier_nonce", signatureMeta.nonce);
      console.log(DBG, "zapier_signature_version", signatureMeta.version);
    } else {
      console.log(DBG, "signing_skipped_no_signature_meta", true);
    }
    console.log(DBG, "object_keys_final", Object.keys(zapierRequestBody));

    console.log("[ZAPIER ACCEPTED WEBHOOK SEND] starting", { public_token: trimmed });
    const headers = { "Content-Type": "application/json" };
    if (signatureMeta) {
      headers["X-MG-Signature"] = signatureMeta.signature;
      headers["X-MG-Timestamp"] = signatureMeta.timestamp;
      headers["X-MG-Nonce"] = signatureMeta.nonce;
      headers["X-MG-Signature-Version"] = signatureMeta.version;
    }
    const res = await fetchFn(acceptedWebhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(zapierRequestBody)
    });
    console.log("[estimate-accepted-webhook] zapier_response_status", res.status);
    if (!res.ok) {
      const zapierErrText = await res.text().catch(() => "");
      console.warn("[estimate-accepted-webhook] zapier_response_text_non2xx", zapierErrText.slice(0, 2000));
      console.warn("[ZAPIER ACCEPTED WEBHOOK] upstream non-OK", { status: res.status });
    }
    console.log("[ZAPIER ACCEPTED WEBHOOK SEND] completed", { status: res.status });
    return { sent: true };
  } catch (zErr) {
    console.error("[ZAPIER ACCEPTED WEBHOOK ERROR]", zErr);
    return { sent: false, error: zErr?.message || "webhook_error" };
  }
}

async function handlePublicEstimateStatus(event, deps = {}) {
  const d = {
    fetchQuoteByPublicToken,
    assertQuoteScheduleAvailable,
    tryAtomicAcceptQuoteReservingSchedule,
    bridgeAcceptedQuoteToProject,
    applyOperationalSnapshotForProject,
    revertQuoteAcceptance,
    sendEstimateAcceptedWebhook,
    getSupabaseConfig,
    fetchImpl: fetch,
    ...deps,
  };

  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    let supabaseUrl;
    let serviceRoleKey;
    try {
      ({ url: supabaseUrl, key: serviceRoleKey } = d.getSupabaseConfig());
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

    let existingRow = null;
    try {
      existingRow = await d.fetchQuoteByPublicToken(supabaseUrl, serviceRoleKey, trimmed);
    } catch (loadErr) {
      return json(loadErr.statusCode || 502, { error: loadErr.message || "Failed to load estimate" });
    }
    if (!existingRow) {
      return json(404, { error: "Estimate not found" });
    }

    // already accepted: do not rewrite accepted_at; do not re-fire Zapier
    if (status === "accepted" && quoteAlreadyAccepted(existingRow)) {
      let bridged = null;
      try {
        bridged = await d.bridgeAcceptedQuoteToProject(existingRow, { strict: true });
        if (!hasConfirmedReservation(bridged)) {
          return json(503, reservationFailedPayload({ already_accepted: true }));
        }
      } catch (bridgeErr) {
        if (isScheduleConflictError(bridgeErr)) {
          return json(409, scheduleConflictPayload());
        }
        console.error("[accept-bridge] tenant_projects heal failed", bridgeErr?.message || bridgeErr);
        return json(503, reservationFailedPayload({ already_accepted: true }));
      }
      return json(200, {
        ok: true,
        status: "accepted",
        already_accepted: true,
        row: sanitizePublicQuoteRow(existingRow),
        project_id: bridged.project_id,
        reserved: true,
      });
    }

    const nowIso = new Date().toISOString();

    if (status === "accepted") {
      let proposed = null;
      try {
        const checked = await d.assertQuoteScheduleAvailable(existingRow);
        proposed = checked.proposed || null;
      } catch (err) {
        if (isScheduleConflictError(err)) {
          return json(409, scheduleConflictPayload());
        }
        throw err;
      }

      const atomic = await d.tryAtomicAcceptQuoteReservingSchedule(
        { ...existingRow, accepted_at: nowIso },
        proposed
      );

      if (atomic && atomic.code === "schedule_conflict") {
        return json(409, scheduleConflictPayload());
      }

      if (atomic && atomic.ok === true && hasConfirmedReservation({ ok: true, project_id: atomic.project_id })) {
        let row = existingRow;
        try {
          const refreshed = await d.fetchQuoteByPublicToken(supabaseUrl, serviceRoleKey, trimmed);
          if (refreshed) row = refreshed;
          else {
            row = {
              ...existingRow,
              status: "accepted",
              accepted_at: existingRow.accepted_at || nowIso,
              updated_at: nowIso
            };
          }
        } catch (_refreshErr) {
          row = {
            ...existingRow,
            status: "accepted",
            accepted_at: existingRow.accepted_at || nowIso,
            updated_at: nowIso
          };
        }
        let snapshotOk = true;
        try {
          if (String(atomic.action || "") === "create") {
            await d.applyOperationalSnapshotForProject(row, atomic.project_id);
          }
        } catch (snapErr) {
          snapshotOk = false;
          console.error(
            "[accept] operational snapshot failed after atomic reservation; schedule remains reserved",
            snapErr
          );
        }
        console.log("[estimate-accepted-webhook] diag_build", "estimate-accepted-webhook-diag-20260503a");
        console.log("[estimate-accepted-webhook] start");
        await d.sendEstimateAcceptedWebhook({
          row,
          token: trimmed,
          supabaseUrl,
          serviceRoleKey,
          fetchImpl: d.fetchImpl,
        });
        return json(200, {
          ok: true,
          status: "accepted",
          row: sanitizePublicQuoteRow(row),
          project_id: atomic.project_id,
          reserved: true,
          snapshot_ok: snapshotOk,
        });
      }

      // Fallback PATCH+bridge is allowed only when the atomic RPC is not installed.
      if (atomic && atomic.code !== "rpc_missing") {
        return json(503, reservationFailedPayload({
          rpc_code: atomic.code || "rpc_failed",
        }));
      }

      const patch = {
        status: "accepted",
        accepted_at: nowIso,
        updated_at: nowIso
      };

      const response = await d.fetchImpl(
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
      if (!rowAccepted) {
        const rolled = await rollbackPatchedQuote(existingRow, d.revertQuoteAcceptance);
        if (rolled) return rolled;
        return json(503, reservationFailedPayload());
      }

      let bridged = null;
      try {
        bridged = await d.bridgeAcceptedQuoteToProject(row, { strict: true });
      } catch (bridgeErr) {
        if (isScheduleConflictError(bridgeErr)) {
          const rolled = await rollbackPatchedQuote(existingRow, d.revertQuoteAcceptance);
          if (rolled) return rolled;
          return json(409, scheduleConflictPayload());
        }
        console.error("[accept-bridge] tenant_projects bridge failed", bridgeErr?.message || bridgeErr);
        const rolled = await rollbackPatchedQuote(existingRow, d.revertQuoteAcceptance);
        if (rolled) return rolled;
        return json(503, reservationFailedPayload());
      }

      if (!hasConfirmedReservation(bridged)) {
        const rolled = await rollbackPatchedQuote(existingRow, d.revertQuoteAcceptance);
        if (rolled) return rolled;
        return json(503, reservationFailedPayload());
      }

      console.log("[estimate-accepted-webhook] diag_build", "estimate-accepted-webhook-diag-20260503a");
      console.log("[estimate-accepted-webhook] start");
      await d.sendEstimateAcceptedWebhook({
        row,
        token: trimmed,
        supabaseUrl,
        serviceRoleKey,
        fetchImpl: d.fetchImpl,
      });
      return json(200, {
        ok: true,
        status: "accepted",
        row: sanitizePublicQuoteRow(row),
        project_id: bridged.project_id,
        reserved: true,
        snapshot_ok: bridged.snapshot_ok !== false,
      });
    }

    const patch = {
      status,
      updated_at: nowIso
    };

    const response = await d.fetchImpl(
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
    return json(200, {
      ok: true,
      status,
      row: sanitizePublicQuoteRow(row)
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
}

exports.handler = async (event) => handlePublicEstimateStatus(event);
exports._test = {
  handlePublicEstimateStatus,
  sendEstimateAcceptedWebhook,
  quoteAlreadyAccepted,
};
