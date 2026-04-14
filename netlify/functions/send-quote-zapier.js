const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available. Set Netlify's Node version to 18+.");
}

/** Default Catch Hook for estimate CTA / send flow (override with ZAPIER_ESTIMATE_CTA_WEBHOOK_URL or ZAPIER_WEBHOOK_URL). */
const DEFAULT_ZAPIER_CTA_WEBHOOK =
  "https://hooks.zapier.com/hooks/catch/22122619/upmpvew/";

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || "https://yaagobzgozzozibublmj.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return { url, key };
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

async function uploadPdfToSupabase({ base64, fileName, estimateNumber }) {
  if (!base64 || !fileName) return null;
  const { url, key } = getSupabaseConfig();
  const bucketName = "estimate-pdfs";
  await ensureBucket(bucketName);

  const safeName =
    String(fileName || `Estimate-${estimateNumber || Date.now()}.pdf`)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || `Estimate-${Date.now()}.pdf`;
  const filePath = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${safeName}`;
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

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    let data = {};
    try {
      data =
        typeof event.body === "string"
          ? JSON.parse(event.body || "{}")
          : event.body && typeof event.body === "object"
            ? event.body
            : {};
    } catch (_e) {
      data = {};
    }

    data.depositRequired = Number(data.depositRequired) || 1000;
    if (typeof data.salesRepInitials === "string") {
      data.salesRepInitials = data.salesRepInitials.trim().slice(0, 6);
    }

    let pdfUrl = null;
    let pdfUploadError = null;
    try {
      pdfUrl = await uploadPdfToSupabase({
        base64: data.pdfBase64,
        fileName: data.pdfFileName,
        estimateNumber: data.estimateNumber
      });
      if (pdfUrl) data.pdfUrl = pdfUrl;
    } catch (pdfError) {
      pdfUploadError = pdfError.message;
      data.pdfUploadError = pdfUploadError;
    }

    const siteUrl = pickFirst(
      process.env.URL,
      process.env.DEPLOY_PRIME_URL,
      process.env.SITE_URL
    ).replace(/\/+$/, "");

    const zapierBody = {
      to_name: data.toName || data.clientName || "",
      client_email: data.toEmail || data.client_email || "",
      project_name: data.projectName || data.project_name || "",
      subject: data.subject || "",
      public_quote_url: data.publicQuoteUrl || data.public_quote_url || "",
      pdf_url: data.pdfUrl || ""
    };

    if (!String(zapierBody.public_quote_url || "").trim()) {
      zapierBody.public_quote_url = resolvePublicQuoteUrl(data, siteUrl);
    }

    console.log("ZAPIER FINAL BODY", zapierBody);

    const webhookUrl = pickFirst(
      process.env.ZAPIER_ESTIMATE_CTA_WEBHOOK_URL,
      process.env.ZAPIER_WEBHOOK_URL
    ) || DEFAULT_ZAPIER_CTA_WEBHOOK;

    console.log("ZAPIER WEBHOOK URL", webhookUrl);

    let zapierDelivery = "skipped";
    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(zapierBody)
      });
      if (resp.ok) {
        zapierDelivery = "ok";
      } else {
        const t = await resp.text();
        zapierDelivery = `error_http_${resp.status}`;
        console.error("[send-quote-zapier] Zapier webhook non-OK:", resp.status, t?.slice(0, 500));
      }
    } catch (err) {
      zapierDelivery = "error_network";
      console.error("[send-quote-zapier] Zapier webhook failed (non-blocking):", err?.message || err);
    }

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
    return { statusCode: 500, body: JSON.stringify({ error: "Server error: " + err.message }) };
  }
};
