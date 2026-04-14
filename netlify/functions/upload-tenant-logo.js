const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available.");
}

const BUCKET = "tenant-logos";
const MAX_BYTES = 2.5 * 1024 * 1024;

const ALLOWED_MIME = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"]
]);

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || "https://yaagobzgozzozibublmj.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return { url, key };
}

async function ensureLogoBucket() {
  const { url, key } = getSupabaseConfig();
  const response = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: true,
      file_size_limit: MAX_BYTES,
      allowed_mime_types: ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"]
    })
  });

  if (response.ok || response.status === 409) return;
  const text = await response.text();
  const alreadyExists =
    response.status === 409 ||
    text.includes("409") ||
    text.includes("Duplicate") ||
    text.includes("already exists");
  if (alreadyExists) return;
  throw new Error(`Unable to ensure logo bucket: ${text}`);
}

async function resolveTenantId(session) {
  let tenants = await supabaseRequest(
    `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=id,stripe_customer_id,owner_email`
  );
  let tenant = Array.isArray(tenants) ? tenants[0] : null;

  if (!tenant?.id && session.e) {
    const byEmail = await supabaseRequest(
      `tenants?owner_email=eq.${encodeURIComponent(String(session.e).trim().toLowerCase())}&select=id,stripe_customer_id,owner_email`
    );
    tenant = Array.isArray(byEmail) ? byEmail[0] : null;
  }

  return tenant?.id || null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_e) {
      return json(400, { error: "Invalid JSON" });
    }

    const mimeType = String(body.mime_type || body.mimeType || "").trim().toLowerCase();
    const base64 = String(body.file_base64 || body.fileBase64 || "").trim();
    if (!base64) {
      return json(400, { error: "Missing file_base64" });
    }
    if (!ALLOWED_MIME.has(mimeType)) {
      return json(400, { error: "Unsupported image type. Use PNG, JPEG, WebP, GIF, or SVG." });
    }

    const tenantId = await resolveTenantId(session);
    if (!tenantId) {
      return json(404, { error: "Tenant not found. Run bootstrap first." });
    }

    let buffer;
    try {
      buffer = Buffer.from(base64, "base64");
    } catch (_e) {
      return json(400, { error: "Invalid base64 payload" });
    }
    if (!buffer.length || buffer.length > MAX_BYTES) {
      return json(400, { error: `Image too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).` });
    }

    const ext = ALLOWED_MIME.get(mimeType);
    const safeId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const filePath = `${tenantId}/${safeId}.${ext}`;

    const { url, key } = getSupabaseConfig();
    await ensureLogoBucket();

    const objectPath = filePath.split("/").map((p) => encodeURIComponent(p)).join("/");
    const uploadResponse = await fetch(`${url}/storage/v1/object/${BUCKET}/${objectPath}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": mimeType,
        "x-upsert": "true"
      },
      body: buffer
    });

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text();
      return json(502, { error: `Upload failed: ${text}` });
    }

    const publicUrl = `${url}/storage/v1/object/public/${BUCKET}/${filePath}`;

    return json(200, {
      ok: true,
      logo_url: publicUrl
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
