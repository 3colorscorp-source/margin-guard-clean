(() => {
  "use strict";

  const API = "/.netlify/functions";
  const SELLER_NOTICE =
    "Seller device mode: pricing and quote drafting enabled. Firmar and Send are disabled until approved.";
  const BLOCKED_ENDPOINT_RE =
    /\/upsert-tenant-project|\/send-quote-zapier|\/publish-public-quote/i;
  const BLOCKED_CONTROL_IDS = new Set([
    "btnMarkSold",
    "btnSendQuote",
    "btnSendQuoteInline",
    "btnSendNow",
    "btnManagePlan",
  ]);

  let sellerModeActive = false;
  let clickGuardInstalled = false;
  let fetchGuardInstalled = false;
  let initPromise = null;

  async function api(path, options = {}) {
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

  function membershipLabel(auth) {
    const m = auth?.membership;
    if (!m || typeof m !== "object") return "Seller device";
    return (
      String(m.display_name || m.full_name || m.email || "").trim() || "Seller device"
    );
  }

  function tenantLabel(auth) {
    const t = auth?.tenant;
    if (!t || typeof t !== "object") return "";
    return String(t.name || t.slug || "").trim();
  }

  function paintOwnerAccount(data) {
    const email = document.getElementById("accountEmail");
    if (email) email.textContent = data.email || "Cuenta activa";

    const plan = document.getElementById("planStatus");
    if (plan) {
      if (data.is_admin) {
        plan.textContent = "Acceso admin (sin suscripción requerida)";
      } else {
        const renewText = data.renewsAt
          ? new Date(data.renewsAt).toLocaleDateString()
          : "";
        plan.textContent = renewText
          ? `Plan anual activo · Renueva ${renewText}`
          : "Plan anual activo";
      }
    }

    const tenantNameEl = document.getElementById("tenantName");
    if (tenantNameEl && data.tenantName) {
      tenantNameEl.textContent = data.tenantName;
    }
  }

  function bindOwnerAccountButtons() {
    const btnManage = document.getElementById("btnManagePlan");
    if (btnManage && btnManage.dataset.mgSalesPortalBound !== "1") {
      btnManage.dataset.mgSalesPortalBound = "1";
      btnManage.addEventListener("click", async () => {
        btnManage.disabled = true;
        btnManage.textContent = "Abriendo...";
        try {
          const { response, data } = await api("/create-portal-session", {
            method: "POST",
            body: "{}",
          });
          if (!response.ok || !data.url) {
            throw new Error(data.error || "No se pudo abrir portal");
          }
          window.location.href = data.url;
        } catch (err) {
          window.alert(err.message || "Error al abrir el portal");
          btnManage.disabled = false;
          btnManage.textContent = "Gestionar plan";
        }
      });
    }

    const btnLogout = document.getElementById("btnLogout");
    if (btnLogout && btnLogout.dataset.mgSalesPortalBound !== "1") {
      btnLogout.dataset.mgSalesPortalBound = "1";
      btnLogout.addEventListener("click", async () => {
        btnLogout.disabled = true;
        try {
          await api("/logout", { method: "POST", body: "{}" });
        } finally {
          window.location.href = "/index.html";
        }
      });
    }
  }

  async function tryOwnerAuth() {
    const { response, data } = await api("/auth-status", { method: "GET" });
    if (!response.ok || !data.active) return null;

    if (window.MarginGuardTenant?.bootstrapTenant) {
      try {
        const { data: tenantData } = await window.MarginGuardTenant.bootstrapTenant();
        if (tenantData?.tenant?.name) data.tenantName = tenantData.tenant.name;
      } catch (_err) {
        /* keep owner access when bootstrap is optional */
      }
    }
    return data;
  }

  function applyOwnerMode(ownerData) {
    sellerModeActive = false;
    window.MG_SALES_PORTAL_MODE = "owner";
    document.documentElement.dataset.authMode = "owner";
    delete document.documentElement.dataset.portalType;
    removeSellerNotice();
    removeDeviceLogoutButton();
    paintOwnerAccount(ownerData);
    bindOwnerAccountButtons();
    document.body.classList.add("auth-ready");
  }

  function ensureSellerNotice() {
    let notice = document.getElementById("mgSellerDeviceNotice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "mgSellerDeviceNotice";
      notice.className = "notice";
      notice.setAttribute("role", "status");
      const container = document.querySelector(".container");
      if (container) {
        container.insertBefore(notice, container.firstChild);
      } else {
        document.body.insertBefore(notice, document.body.firstChild);
      }
    }
    notice.textContent = SELLER_NOTICE;
    notice.hidden = false;
    notice.style.display = "";
  }

  function removeSellerNotice() {
    const notice = document.getElementById("mgSellerDeviceNotice");
    if (notice) notice.remove();
  }

  function hideOwnerChrome() {
    document.querySelectorAll("[data-owner-nav]").forEach((el) => {
      el.setAttribute("hidden", "");
      el.setAttribute("aria-hidden", "true");
      if ("disabled" in el) {
        el.disabled = true;
      }
    });
  }

  function showSellerAccountPill(auth) {
    const email = document.getElementById("accountEmail");
    if (!email) return;
    const tenant = tenantLabel(auth);
    const member = membershipLabel(auth);
    email.textContent = tenant ? `${member} · ${tenant}` : member;
  }

  function ensureDeviceLogoutButton() {
    let btn = document.getElementById("btnDeviceLogout");
    if (btn) return btn;

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn danger";
    btn.id = "btnDeviceLogout";
    btn.textContent = "Cerrar sesion dispositivo";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        if (window.MGDevicePortal?.logout) {
          await window.MGDevicePortal.logout();
          return;
        }
        await api("/device-logout", { method: "POST", body: "{}" });
      } finally {
        window.location.href = "/portal-pair?portal=seller";
      }
    });

    const actions = document.querySelector(".topbar-actions");
    if (actions) {
      actions.appendChild(btn);
    }
    return btn;
  }

  function removeDeviceLogoutButton() {
    const btn = document.getElementById("btnDeviceLogout");
    if (btn) btn.remove();
  }

  function disableBlockedControls() {
    BLOCKED_CONTROL_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = true;
      el.setAttribute("aria-disabled", "true");
      el.setAttribute("data-mg-seller-blocked", "1");
      el.title = "Disabled in seller device mode";
    });
  }

  function isBlockedControlTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    for (const id of BLOCKED_CONTROL_IDS) {
      const el = document.getElementById(id);
      if (el && (target === el || el.contains(target))) return true;
    }
    return false;
  }

  function installClickGuard() {
    if (clickGuardInstalled) return;
    clickGuardInstalled = true;
    document.addEventListener(
      "click",
      (event) => {
        if (!sellerModeActive) return;
        if (!isBlockedControlTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        window.alert(SELLER_NOTICE);
      },
      true
    );
  }

  function installFetchGuard() {
    if (fetchGuardInstalled || typeof window.fetch !== "function") return;
    fetchGuardInstalled = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function salesDeviceGuardedFetch(input, init) {
      if (sellerModeActive) {
        const url = String(
          typeof input === "string" ? input : input && input.url ? input.url : ""
        );
        if (BLOCKED_ENDPOINT_RE.test(url)) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: "Blocked in seller device mode",
                code: "seller_device_blocked",
              }),
              {
                status: 403,
                headers: { "Content-Type": "application/json" },
              }
            )
          );
        }
      }
      return nativeFetch(input, init);
    };
  }

  function applySellerMode(auth) {
    sellerModeActive = true;
    window.MG_SALES_PORTAL_MODE = "device";
    document.documentElement.dataset.authMode = "device";
    document.documentElement.dataset.portalType = "seller";

    const plan = document.getElementById("planStatus");
    if (plan) plan.textContent = "Seller device · Vendedor";

    hideOwnerChrome();
    ensureSellerNotice();
    showSellerAccountPill(auth);
    ensureDeviceLogoutButton();
    disableBlockedControls();
    installClickGuard();
    installFetchGuard();

    // Inline sales handlers clone Firmar/send buttons on DOMContentLoaded; re-apply after they run.
    requestAnimationFrame(() => {
      disableBlockedControls();
      setTimeout(disableBlockedControls, 0);
    });

    document.body.classList.add("auth-ready");
    window.dispatchEvent(
      new CustomEvent("device-auth-ready", { detail: { auth } })
    );
  }

  async function initSalesPortalAuth() {
    const ownerData = await tryOwnerAuth();
    if (ownerData) {
      applyOwnerMode(ownerData);
      return;
    }

    if (!window.MGDevicePortal?.init) {
      window.location.href = "/portal-pair?portal=seller";
      return;
    }

    const auth = await window.MGDevicePortal.init({ expectedPortal: "seller" });
    if (!auth) {
      return;
    }
    applySellerMode(auth);
  }

  function boot() {
    if (document.body?.dataset?.salesDualAuth !== "true") return;
    if (!initPromise) {
      initPromise = initSalesPortalAuth().catch(() => {
        window.location.href = "/portal-pair?portal=seller";
      });
    }
    return initPromise;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.MGSalesDevicePortal = {
    boot,
    isSellerMode: () => sellerModeActive,
  };
})();
