(() => {
  const API_BASE = "/.netlify/functions";

  async function tenantApi(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_err) {
      data = {};
    }
    return { response, data };
  }

  async function bootstrapTenant() {
    return tenantApi("/bootstrap-tenant", { method: "POST", body: "{}" });
  }

  async function loadTenantContext() {
    return tenantApi("/tenant-context", { method: "GET" });
  }

  async function saveTenantSnapshot(payload) {
    return tenantApi("/save-tenant-snapshot", {
      method: "POST",
      body: JSON.stringify({ snapshot_version: 1, payload })
    });
  }

  async function loadTenantSnapshot() {
    return tenantApi("/load-tenant-snapshot", { method: "GET" });
  }

  let tenantBrandingPromise = null;

  async function getTenantBranding(options = {}) {
    const force = Boolean(options.force);
    if (force) {
      tenantBrandingPromise = null;
    }
    if (!tenantBrandingPromise) {
      tenantBrandingPromise = tenantApi("/get-tenant-branding", { method: "GET" });
    }
    return tenantBrandingPromise;
  }

  function clearTenantBrandingCache() {
    tenantBrandingPromise = null;
  }

  window.MarginGuardTenant = {
    bootstrapTenant,
    loadTenantContext,
    saveTenantSnapshot,
    loadTenantSnapshot,
    getTenantBranding,
    clearTenantBrandingCache
  };
})();
