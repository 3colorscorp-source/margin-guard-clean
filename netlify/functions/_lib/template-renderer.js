/**
 * CH-013A.2.0 — Channel-agnostic template renderer.
 * Returns a normalized render model only — no HTML / SMS body yet.
 * Does not log or persist. Must never receive raw tokens.
 */

"use strict";

const API_VERSION = "ch-013a20-v1";

function trimField(value) {
  return value == null ? "" : String(value).trim();
}

/**
 * @param {{
 *   channel: string,
 *   template_id?: string,
 *   branding?: object,
 *   signing_link?: object|string|null,
 *   recipient?: object|null,
 *   project?: object|null,
 *   metadata?: object|null,
 * }} input
 */
function renderTemplate(input = {}) {
  if (
    input.raw_token != null ||
    input.raw_token_once != null ||
    input.oneShotSecret != null ||
    input.token != null
  ) {
    return {
      ok: false,
      error: "raw token must not be passed to template renderer",
      code: "raw_token_forbidden",
    };
  }

  const channel = trimField(input.channel).toLowerCase();
  if (!channel) {
    return { ok: false, error: "channel is required", code: "missing_channel" };
  }

  const signingLink =
    input.signing_link && typeof input.signing_link === "object"
      ? input.signing_link
      : input.signing_link
        ? { url: String(input.signing_link) }
        : null;

  const recipient =
    input.recipient && typeof input.recipient === "object" ? input.recipient : {};
  const project =
    input.project && typeof input.project === "object" ? input.project : {};
  const branding =
    input.branding && typeof input.branding === "object" ? { ...input.branding } : {};

  const metadata =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? { ...input.metadata }
      : {};
  delete metadata.raw_token;
  delete metadata.raw_token_once;
  delete metadata.oneShotSecret;
  delete metadata.signing_url;
  delete metadata.token;
  delete metadata.token_hash;

  const model = Object.freeze({
    channel,
    template_id: trimField(input.template_id) || `${channel}.default`,
    branding: Object.freeze({ ...branding }),
    signing_link: signingLink
      ? Object.freeze({
          url: trimField(signingLink.url),
          expires_at: signingLink.expires_at || null,
          generation_number:
            signingLink.generation_number != null
              ? Number(signingLink.generation_number)
              : null,
        })
      : null,
    recipient: Object.freeze({
      masked_email: trimField(recipient.masked_email),
      party_name: trimField(recipient.party_name),
      email: undefined,
    }),
    project: Object.freeze({
      project_id: project.project_id || project.id || null,
      project_name: trimField(project.project_name || project.name),
    }),
    metadata: Object.freeze(metadata),
  });

  return {
    ok: true,
    api_version: API_VERSION,
    payload: model,
  };
}

module.exports = {
  API_VERSION,
  renderTemplate,
};
