/**
 * CH-013A.2.1 — Provider transport interface (normalized contract).
 * Channel adapters must talk to providers through this shape only.
 * No credentials. No Resend HTTP here.
 */

"use strict";

const API_VERSION = "ch-013a21-v1";

function trimField(value) {
  return value == null ? "" : String(value).trim();
}

/**
 * Normalize a provider send() result into the canonical shape.
 * @returns {{
 *   accepted: boolean,
 *   retryable: boolean,
 *   provider: string,
 *   provider_message_id: string|null,
 *   error_code: string|null,
 *   error_message: string|null,
 * }}
 */
function normalizeSendResult(input = {}) {
  const accepted = input.accepted === true;
  return {
    accepted,
    retryable: accepted ? false : input.retryable === true,
    provider: trimField(input.provider) || "unknown",
    provider_message_id: accepted
      ? trimField(input.provider_message_id) || null
      : null,
    error_code: accepted ? null : trimField(input.error_code) || "provider_error",
    error_message: accepted
      ? null
      : String(input.error_message || input.error || "provider error").slice(0, 500),
  };
}

/**
 * Normalize health().
 */
function normalizeHealth(input = {}) {
  return {
    available: input.available === true,
    provider: trimField(input.provider) || "unknown",
    reason: trimField(input.reason) || (input.available === true ? "" : "unavailable"),
  };
}

/**
 * Capability flags default (fail-closed for tracking/templates/etc.).
 */
function defaultCapabilities(overrides = {}) {
  return {
    supportsTracking: overrides.supportsTracking === true,
    supportsTemplates: overrides.supportsTemplates === true,
    supportsBranding: overrides.supportsBranding === true,
    supportsAttachments: overrides.supportsAttachments === true,
  };
}

/**
 * Classify HTTP-ish provider failures without logging bodies/keys.
 */
function classifyHttpFailure(status, networkError) {
  if (networkError) {
    return {
      accepted: false,
      retryable: true,
      error_code: "network_timeout",
      error_message: "Provider network error or timeout",
    };
  }
  const code = Number(status);
  if (code === 401 || code === 403) {
    return {
      accepted: false,
      retryable: false,
      error_code: "provider_auth_fatal",
      error_message: "Provider authentication or authorization failure",
    };
  }
  if (code === 429 || (code >= 500 && code <= 599)) {
    return {
      accepted: false,
      retryable: true,
      error_code: code === 429 ? "provider_rate_limited" : "provider_server_error",
      error_message: `Provider HTTP ${code}`,
    };
  }
  if (code >= 400 && code < 500) {
    return {
      accepted: false,
      retryable: false,
      error_code: "provider_client_error",
      error_message: `Provider HTTP ${code}`,
    };
  }
  return {
    accepted: false,
    retryable: true,
    error_code: "provider_unknown_error",
    error_message: `Provider HTTP ${code || "unknown"}`,
  };
}

module.exports = {
  API_VERSION,
  normalizeSendResult,
  normalizeHealth,
  defaultCapabilities,
  classifyHttpFailure,
  trimField,
};
