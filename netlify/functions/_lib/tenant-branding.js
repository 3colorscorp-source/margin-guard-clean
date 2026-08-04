/**
 * CH-013A.2.0 — Tenant Branding Resolver.
 * Returns an immutable BrandingSnapshot for all delivery channels.
 * Defaults are tenant-neutral (no customer brand hardcoding).
 */

"use strict";

const { loadTenantDisplayForTenantId, pickFirst } = require("./tenant-display");

const API_VERSION = "ch-013a20-v1";

/** Safe platform defaults — not a specific customer identity. */
const DEFAULT_BRANDING = Object.freeze({
  business_name: "",
  logo_url: "",
  primary_color: "#0f172a",
  accent_color: "#2563eb",
  reply_to: "",
  from_name: "",
  website: "",
  phone: "",
  legal_footer: "",
  locale: "en-US",
});

function trimField(value) {
  return value == null ? "" : String(value).trim();
}

function freezeSnapshot(row) {
  return Object.freeze({
    business_name: trimField(row.business_name),
    logo_url: trimField(row.logo_url),
    primary_color: trimField(row.primary_color) || DEFAULT_BRANDING.primary_color,
    accent_color: trimField(row.accent_color) || DEFAULT_BRANDING.accent_color,
    reply_to: trimField(row.reply_to),
    from_name: trimField(row.from_name) || trimField(row.business_name),
    website: trimField(row.website),
    phone: trimField(row.phone),
    legal_footer: trimField(row.legal_footer),
    locale: trimField(row.locale) || DEFAULT_BRANDING.locale,
  });
}

/**
 * Resolve branding for a tenant. Always returns a frozen snapshot (new object each call).
 * Reads tenant Business Settings / tenant_branding when available.
 */
async function resolveTenantBranding(tenantId) {
  if (!tenantId) {
    return {
      ok: true,
      api_version: API_VERSION,
      branding: freezeSnapshot({ ...DEFAULT_BRANDING }),
      source: "defaults",
    };
  }

  try {
    const display = await loadTenantDisplayForTenantId(tenantId);
    const branding = freezeSnapshot({
      business_name: pickFirst(display.business_name),
      logo_url: display.logo_url,
      primary_color: display.primary_color,
      accent_color: display.accent_color,
      reply_to: pickFirst(display.business_email, display.reply_to),
      from_name: pickFirst(display.business_name),
      website: display.website,
      phone: pickFirst(display.business_phone, display.phone),
      legal_footer: display.legal_footer,
      locale: display.locale,
    });
    return {
      ok: true,
      api_version: API_VERSION,
      branding,
      source: "tenant_branding",
    };
  } catch (_err) {
    return {
      ok: true,
      api_version: API_VERSION,
      branding: freezeSnapshot({ ...DEFAULT_BRANDING }),
      source: "defaults",
    };
  }
}

module.exports = {
  API_VERSION,
  DEFAULT_BRANDING,
  resolveTenantBranding,
  freezeSnapshot,
};
