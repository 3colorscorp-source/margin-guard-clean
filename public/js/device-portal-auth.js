(() => {
  "use strict";

  const API = "/.netlify/functions";
  const HEARTBEAT_MS = 5 * 60 * 1000;

  let heartbeatTimer = null;
  let initStarted = false;

  function normPortal(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function safeAuthFromResponse(data) {
    if (!data || data.ok !== true || data.active !== true) return null;
    return {
      ok: true,
      active: true,
      auth_mode: data.auth_mode || "device",
      portal_type: data.portal_type || null,
      tenant: data.tenant || null,
      membership: data.membership || null,
      device: data.device || null,
      expires_at: data.expires_at || null,
    };
  }

  async function apiRequest(path, options) {
    const response = await fetch(`${API}${path}`, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_err) {
      data = {};
    }
    return { response, data };
  }

  function redirectToPair(portal) {
    const p = normPortal(portal);
    const qs =
      p === "seller" || p === "supervisor"
        ? `?portal=${encodeURIComponent(p)}`
        : "";
    window.location.href = `/portal-pair${qs}`;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function sendHeartbeat() {
    try {
      await apiRequest("/device-heartbeat", { method: "POST", body: "{}" });
    } catch (_err) {
      /* silent — next interval or auth refresh will surface invalid session */
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    void sendHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      void sendHeartbeat();
    }, HEARTBEAT_MS);
  }

  function applyDeviceAuth(auth) {
    window.MG_DEVICE_AUTH = auth;
    document.documentElement.dataset.authMode = "device";
    if (auth?.portal_type) {
      document.documentElement.dataset.portalType = normPortal(auth.portal_type);
    }
    window.dispatchEvent(
      new CustomEvent("device-auth-ready", { detail: { auth } })
    );
  }

  async function logout() {
    stopHeartbeat();
    const portal =
      normPortal(window.MG_DEVICE_AUTH?.portal_type) ||
      normPortal(window.MG_EXPECTED_PORTAL);
    try {
      await apiRequest("/device-logout", { method: "POST", body: "{}" });
    } catch (_err) {
      /* still redirect and clear local state */
    }
    window.MG_DEVICE_AUTH = null;
    delete document.documentElement.dataset.authMode;
    delete document.documentElement.dataset.portalType;
    redirectToPair(portal);
  }

  async function init(options) {
    if (initStarted) return window.MG_DEVICE_AUTH || null;
    initStarted = true;

    const expectedPortal = normPortal(
      options?.expectedPortal || window.MG_EXPECTED_PORTAL || ""
    );

    const { response, data } = await apiRequest("/device-auth-status", {
      method: "GET",
    });

    const auth = safeAuthFromResponse(data);
    if (!response.ok || !auth) {
      redirectToPair(expectedPortal);
      return null;
    }

    const actualPortal = normPortal(auth.portal_type);
    if (expectedPortal && actualPortal && expectedPortal !== actualPortal) {
      try {
        await apiRequest("/device-logout", { method: "POST", body: "{}" });
      } catch (_err) {
        /* continue to pair redirect */
      }
      redirectToPair(expectedPortal);
      return null;
    }

    applyDeviceAuth(auth);
    startHeartbeat();
    return auth;
  }

  window.MGDevicePortal = {
    init,
    logout,
    stopHeartbeat,
    getAuth: () => window.MG_DEVICE_AUTH || null,
  };

  if (window.MG_DEVICE_PORTAL_AUTO_INIT !== false) {
    document.addEventListener("DOMContentLoaded", () => {
      void init();
    });
  }
})();
