const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify's Node version to 18+.");
}

const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest, getSupabaseConfig } = require("./_lib/supabase-admin");
const { makeReqId, logOps, truncatePublicToken } = require("./_lib/ops-log");

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

async function ensureBucket(bucketName) {
  const { url, key } = getSupabaseConfig();
  const response = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      id: bucketName,
      name: bucketName,
      public: true,
      allowed_mime_types: ["application/pdf"]
    })
  });

  if (response.ok || response.status === 409) return;

  const text = await response.text();
  const alreadyExists =
    response.status === 409 ||
    text.includes('"statusCode":"409"') ||
    text.includes('"statusCode":409') ||
    text.includes("Duplicate") ||
    text.includes("The resource already exists");

  if (alreadyExists) return;

  throw new Error(`Unable to ensure PDF bucket: ${text}`);
}

async function uploadPdfToSupabase({ base64, fileName, estimateNumber, tenantId }) {
  if (!base64 || !fileName || !tenantId) return null;
  const { url, key } = getSupabaseConfig();
  const bucketName = "estimate-pdfs";
  await ensureBucket(bucketName);

  const safeName =
    String(fileName || `Estimate-${estimateNumber || Date.now()}.pdf`)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || `Estimate-${Date.now()}.pdf`;
  const tenantSegment = String(tenantId).trim();
  const filePath = `${tenantSegment}/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${safeName}`;
  const objectPath = filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
  const bytes = Buffer.from(base64, "base64");

  const uploadResponse = await fetch(`${url}/storage/v1/object/${bucketName}/${objectPath}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true"
    },
    body: bytes
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`Unable to upload estimate PDF: ${text}`);
  }

  return `${url}/storage/v1/object/public/${bucketName}/${filePath}`;
}

/** Fills public_quote_url when client omitted it (Netlify URL + token). */
function resolvePublicQuoteUrl(data, siteUrl) {
  const publicToken = pickFirst(data.publicToken, data.public_token);
  const fromClient = pickFirst(data.publicQuoteUrl, data.public_quote_url);
  const built =
    siteUrl && publicToken
      ? `${siteUrl}/estimate-public.html?token=${encodeURIComponent(publicToken)}`
      : "";

  let out = fromClient || built || "";
  if (!String(out).trim() && siteUrl) {
    out = `${siteUrl}/estimate-public.html${publicToken ? `?token=${encodeURIComponent(publicToken)}` : ""}`;
  }
  if (!String(out).trim()) {
    out = "https://estimate-public.invalid/estimate-public.html";
  }
  return String(out).trim();
}

const OPS_FN = "send-quote-zapier";

exports.handler = async (event) => {
  const req_id = makeReqId();

  try {
    if (event.httpMethod !== "POST") {
      logOps({
        req_id,
        fn: OPS_FN,
        event: "method_not_allowed",
        level: "warn",
        outcome: "fail",
        http_status: 405,
        detail: "expected POST"
      });
      return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      logOps({
        req_id,
        fn: OPS_FN,
        event: "auth_fail",
        level: "warn",
        outcome: "fail",
        http_status: 401,
        detail: "missing session"
      });
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      logOps({
        req_id,
        fn: OPS_FN,
        event: "tenant_missing",
        level: "warn",
        outcome: "fail",
        http_status: 401,
        detail: "no tenant for session"
      });
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    let data = {};
    let bodyParseFailed = false;
    try {
      data =
        typeof event.body === "string"
          ? JSON.parse(event.body || "{}")
          : event.body && typeof event.body === "object"
            ? event.body
            : {};
    } catch (_e) {
      data = {};
      bodyParseFailed = true;
    }

    if (bodyParseFailed) {
      logOps({
        req_id,
        fn: OPS_FN,
        event: "body_parse_failed",
        level: "warn",
        outcome: "warn",
        tenant_id: tenant.id,
        http_status: null,
        detail: "JSON parse failed; continuing with empty object"
      });
    }

    const publicToken = pickFirst(data.publicToken, data.public_token);
    const publicTokenLog = truncatePublicToken(publicToken);
    let quoteId = null;

    if (publicToken) {
      const rows = await supabaseRequest(
        `quotes?public_token=eq.${encodeURIComponent(publicToken)}&tenant_id=eq.${encodeURIComponent(String(tenant.id))}&select=id&limit=1`
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        logOps({
          req_id,
          fn: OPS_FN,
          event: "quote_scope_forbidden",
          level: "warn",
          outcome: "fail",
          tenant_id: tenant.id,
          public_token: publicTokenLog,
          http_status: 403,
          detail: "no quote for token and tenant"
        });
        return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
      }
      quoteId = rows[0]?.id != null ? String(rows[0].id) : null;
      logOps({
        req_id,
        fn: OPS_FN,
        event: "quote_scope_ok",
        level: "info",
        outcome: "ok",
        tenant_id: tenant.id,
        quote_id: quoteId,
        public_token: publicTokenLog
      });
    }

    data.depositRequired = Number(data.depositRequired) || 1000;
    if (typeof data.salesRepInitials === "string") {
      data.salesRepInitials = data.salesRepInitials.trim().slice(0, 6);
    }

    let pdfUrl = null;
    let pdfUploadError = null;
    const hadPdfPayload = Boolean(data.pdfBase64 && String(data.pdfBase64).trim());
    try {
      pdfUrl = await uploadPdfToSupabase({
        base64: data.pdfBase64,
        fileName: data.pdfFileName,
        estimateNumber: data.estimateNumber,
        tenantId: tenant.id
      });
      if (pdfUrl) data.pdfUrl = pdfUrl;
    } catch (pdfError) {
      pdfUploadError = pdfError.message;
      data.pdfUploadError = pdfUploadError;
    }

    if (!hadPdfPayload) {
      logOps({
        req_id,
        fn: OPS_FN,
        event: "pdf_upload",
        level: "info",
        outcome: "ok",
        tenant_id: tenant.id,
        quote_id: quoteId,
        public_token: publicTokenLog,
        detail: "skipped_no_pdf_payload"
      });
    } else if (pdfUrl) {
      logOps({
        req_id,
        fn: OPS_FN,
        event: "pdf_upload",
        level: "info",
        outcome: "ok",
        tenant_id: tenant.id,
        quote_id: quoteId,
        public_token: publicTokenLog,
        detail: "storage_upload_ok"
      });
    } else {
      logOps({
        req_id,
        fn: OPS_FN,
        event: "pdf_upload",
        level: "warn",
        outcome: "fail",
        tenant_id: tenant.id,
        quote_id: quoteId,
        public_token: publicTokenLog,
        detail: pdfUploadError || "upload_failed"
      });
    }

    const siteUrl = pickFirst(
      process.env.URL,
      process.env.DEPLOY_PRIME_URL,
      process.env.SITE_URL
    ).replace(/\/+$/, "");

    let tenantSlug = "";
    let businessName = "";
    try {
      const metaRows = await supabaseRequest(
        `tenants?id=eq.${encodeURIComponent(String(tenant.id))}&select=slug,name&limit=1`
      );
      const tr = Array.isArray(metaRows) && metaRows[0] ? metaRows[0] : null;
      if (tr) {
        tenantSlug = String(tr.slug ?? "").trim();
        businessName = String(tr.name ?? "").trim();
      }
    } catch (_e) {
      /* optional tenant metadata for Zapier */
    }

    const zapierBody = {
      tenant_id: String(tenant.id),
      tenant_slug: tenantSlug,
      business_name: businessName,
      to_name: data.toName || data.clientName || "",
      client_email: data.toEmail || data.client_email || "",
      project_name: data.projectName || data.project_name || "",
      subject: data.subject || "",
      public_quote_url: data.publicQuoteUrl || data.public_quote_url || "",
      pdf_url: data.pdfUrl || "",
      additional_recipients:
        data.additional_recipients !== undefined && data.additional_recipients !== null
          ? String(data.additional_recipients)
          : ""
    };

    if (!String(zapierBody.public_quote_url || "").trim()) {
      zapierBody.public_quote_url = resolvePublicQuoteUrl(data, siteUrl);
    }

    const webhookUrl = pickFirst(
      process.env.ZAPIER_ESTIMATE_CTA_WEBHOOK_URL,
      process.env.ZAPIER_WEBHOOK_URL
    );

    let zapierDelivery = "skipped";
    if (!webhookUrl) {
      console.log(
        "[send-quote-zapier] Zapier webhook not configured (set ZAPIER_ESTIMATE_CTA_WEBHOOK_URL or ZAPIER_WEBHOOK_URL); skipping outbound POST"
      );
      logOps({
        req_id,
        fn: OPS_FN,
        event: "zapier_dispatch",
        level: "info",
        outcome: "skipped",
        tenant_id: tenant.id,
        quote_id: quoteId,
        public_token: publicTokenLog,
        detail: "no_webhook_url_configured; outbound skipped"
      });
      zapierDelivery = "skipped_no_webhook_url";
    } else {
      try {
        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(zapierBody)
        });
        if (resp.ok) {
          zapierDelivery = "ok";
          logOps({
            req_id,
            fn: OPS_FN,
            event: "zapier_dispatch",
            level: "info",
            outcome: "ok",
            tenant_id: tenant.id,
            quote_id: quoteId,
            public_token: publicTokenLog,
            detail: "webhook_post_ok;source=env"
          });
        } else {
          await resp.text();
          zapierDelivery = `error_http_${resp.status}`;
          logOps({
            req_id,
            fn: OPS_FN,
            event: "zapier_dispatch",
            level: "warn",
            outcome: "fail",
            tenant_id: tenant.id,
            quote_id: quoteId,
            public_token: publicTokenLog,
            detail: `http_${resp.status};source=env`
          });
        }
      } catch (err) {
        zapierDelivery = "error_network";
        logOps({
          req_id,
          fn: OPS_FN,
          event: "zapier_dispatch",
          level: "error",
          outcome: "fail",
          tenant_id: tenant.id,
          quote_id: quoteId,
          public_token: publicTokenLog,
          detail: `network;source=env;${err?.message || "fetch_failed"}`
        });
      }
    }

    logOps({
      req_id,
      fn: OPS_FN,
      event: "request_complete",
      level: "info",
      outcome: "ok",
      tenant_id: tenant.id,
      quote_id: quoteId,
      public_token: publicTokenLog,
      http_status: 200,
      detail: `zapier:${zapierDelivery};pdf:${pdfUrl ? "ok" : hadPdfPayload ? "fail" : "skip"}`
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        pdfUrl: pdfUrl || null,
        pdfUploadError: pdfUploadError || null,
        public_quote_url: zapierBody.public_quote_url,
        zapier: zapierDelivery
      })
    };
  } catch (err) {
    logOps({
      req_id,
      fn: OPS_FN,
      event: "unhandled_error",
      level: "error",
      outcome: "fail",
      http_status: 500,
      detail: err?.message || "unknown"
    });
    return { statusCode: 500, body: JSON.stringify({ error: "Server error: " + err.message }) };
  }
};
