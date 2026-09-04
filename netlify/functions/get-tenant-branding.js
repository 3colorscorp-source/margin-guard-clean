const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { requireSellerDevice } = require("./_lib/tenant-device-guard");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

function asRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

function createHandler(deps = {}) {
  const readSession = deps.readSessionFromEvent || readSessionFromEvent;
  const resolveTenant = deps.resolveTenantFromSession || resolveTenantFromSession;
  const requireSeller = deps.requireSellerDevice || requireSellerDevice;
  const requestFn = deps.supabaseRequest || supabaseRequest;

  async function resolveBrandingTenant(event) {
    const session = readSession(event);
    if (session?.e) {
      const tenant = await resolveTenant(session);
      if (tenant?.id) {
        return { tenant, auth_mode: "owner" };
      }
    }

    try {
      const deviceCtx = await requireSeller(event);
      if (deviceCtx?.tenant?.id) {
        return { tenant: deviceCtx.tenant, auth_mode: "device" };
      }
    } catch (err) {
      if (err && err.isGuardError) {
        const status = Number(err.statusCode) || 401;
        const error = new Error(err.message || "Unauthorized");
        error.statusCode = status;
        throw error;
      }
      throw err;
    }

    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }

  return async function handler(event) {
    try {
      if (event.httpMethod !== "GET") {
        return json(405, { error: "Method not allowed" });
      }

      const { tenant } = await resolveBrandingTenant(event);
      const tenantId = String(tenant.id || "").trim();
      if (!tenantId) {
        return json(404, { error: "Tenant not found. Run bootstrap first." });
      }

      let branding = null;
      try {
        const rows = asRows(
          await requestFn(
            `tenant_branding?tenant_id=eq.${encodeURIComponent(tenantId)}&select=*`
          )
        );
        branding = rows[0] || null;
      } catch (_err) {
        branding = null;
      }

      const fallbackName = String(tenant.name || "").trim();
      const merged = {
        business_name: String(branding?.business_name || fallbackName || "").trim(),
        logo_url: String(branding?.logo_url || "").trim(),
        business_email: String(branding?.business_email || "").trim(),
        business_phone: String(branding?.business_phone || "").trim(),
        business_address: String(branding?.business_address || "").trim()
      };

      return json(200, { ok: true, branding: merged });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      if (status === 401 || status === 403 || status === 404) {
        return json(status, { error: err.message || "Unauthorized" });
      }
      return json(500, { error: err.message || "Unable to load tenant branding" });
    }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
