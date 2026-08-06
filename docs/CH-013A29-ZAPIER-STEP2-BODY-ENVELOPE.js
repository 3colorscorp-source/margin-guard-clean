/**
 * CH-013A.2.9 — Zapier Step 2 "HMAC and Schema Validation" (Code by Zapier).
 *
 * Paste this entire file as the Code step body (keep the export default line).
 *
 * Input mappings (ONLY these two):
 *   raw_body     ← Catch Raw Hook "Raw Body"
 *   hmac_secret  ← CONTRACT_EMAIL_ZAPIER_HMAC_SECRET (Zapier secret / store)
 *
 * Do NOT map signature_header, timestamp_header, or headers_json.
 * HMAC lives in the body envelope (timestamp + signature + signed_body).
 */
export default async function main(inputData) {
  const crypto = require("crypto");

  const SKEW_MS = 5 * 60 * 1000;

  // Zapier omits null/undefined from Data Out — every field is a string, always.
  const out = {
    valid: "false",
    validation_error: "",
    schema_version: "",
    event_type: "",
    tenant_id: "",
    project_id: "",
    envelope_id: "",
    invitation_id: "",
    generation_id: "",
    generation_number: "",
    attempt_id: "",
    recipient_email: "",
    recipient_name: "",
    subject: "",
    html_body: "",
    text_body: "",
    reply_to: "",
    from_name: "",
    expires_at: "",
    correlation_id: "",
    idempotency_key: "",
  };

  const str = function (v) {
    return v === null || v === undefined ? "" : String(v);
  };

  const fail = function (reason) {
    out.valid = "false";
    out.validation_error = reason;
    return out;
  };

  try {
    const rawBody = str(inputData && inputData.raw_body);
    const secret = str(inputData && inputData.hmac_secret);

    if (!rawBody) return fail("missing raw_body");
    if (!secret) return fail("missing hmac_secret");

    let envelope = null;
    try {
      envelope = JSON.parse(rawBody);
    } catch (parseOuter) {
      return fail("envelope_not_json");
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      return fail("envelope_invalid");
    }

    const timestamp = str(envelope.timestamp);
    const signature = str(envelope.signature).toLowerCase();
    // signed_body must be the exact string used for HMAC — never rebuild.
    if (envelope.signed_body == null || envelope.signed_body === "") {
      return fail("missing signed_body");
    }
    if (typeof envelope.signed_body !== "string") {
      return fail("signed_body_invalid");
    }
    const signedBody = envelope.signed_body;

    if (!timestamp) return fail("missing timestamp");
    if (!signature) return fail("missing signature");
    if (!/^[0-9a-f]+$/.test(signature) || signature.length % 2 !== 0) {
      return fail("signature_invalid");
    }

    const ts = Date.parse(timestamp);
    if (!isFinite(ts)) return fail("timestamp_invalid");
    const delta = ts - Date.now();
    if (delta > SKEW_MS) return fail("timestamp_future");
    if (delta < -SKEW_MS) return fail("timestamp_stale");

    const expected = crypto
      .createHmac("sha256", secret)
      .update(timestamp + "." + signedBody, "utf8")
      .digest("hex")
      .toLowerCase();

    let match = expected.length === signature.length;
    if (match) {
      try {
        match = crypto.timingSafeEqual(
          Buffer.from(signature, "utf8"),
          Buffer.from(expected, "utf8")
        );
      } catch (compareError) {
        match = false;
      }
    }
    if (!match) return fail("signature_mismatch");

    let payload = null;
    try {
      payload = JSON.parse(signedBody);
    } catch (parseInner) {
      return fail("body_not_json");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return fail("body_not_object");
    }

    if (str(payload.event_type) !== "contract_signing_invitation") {
      return fail("event_type_invalid");
    }

    const required = ["attempt_id", "invitation_id", "recipient_email", "subject"];
    for (let i = 0; i < required.length; i += 1) {
      if (!str(payload[required[i]])) return fail("missing " + required[i]);
    }
    if (!str(payload.html_body) && !str(payload.text_body)) {
      return fail("missing message body");
    }

    out.schema_version = str(payload.schema_version);
    out.event_type = str(payload.event_type);
    out.tenant_id = str(payload.tenant_id);
    out.project_id = str(payload.project_id);
    out.envelope_id = str(payload.envelope_id);
    out.invitation_id = str(payload.invitation_id);
    out.generation_id = str(payload.generation_id);
    out.generation_number = str(payload.generation_number);
    out.attempt_id = str(payload.attempt_id);
    out.recipient_email = str(payload.recipient_email);
    out.recipient_name = str(payload.recipient_name);
    out.subject = str(payload.subject);
    out.html_body = str(payload.html_body);
    out.text_body = str(payload.text_body);
    out.reply_to = str(payload.reply_to);
    out.from_name = str(payload.from_name);
    out.expires_at = str(payload.expires_at);
    out.correlation_id = str(payload.correlation_id);
    out.idempotency_key = str(payload.idempotency_key);

    out.valid = "true";
    out.validation_error = "";
    return out;
  } catch (err) {
    out.valid = "false";
    out.validation_error =
      "code_step_exception: " + str(err && err.message ? err.message : err);
    return out;
  }
}
