"use strict";

const crypto = require("crypto");

function hashId(value) {
  const raw = String(value || "");
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
}

function logSquareSaas(fields) {
  const safe = {
    event_type: fields.event_type || null,
    event_id_hash: hashId(fields.event_id),
    processing_status: fields.processing_status || null,
    onboarding_id: fields.onboarding_id || null,
    error_code: fields.error_code || null,
  };
  console.log("[square-saas]", safe);
}

module.exports = { hashId, logSquareSaas };
