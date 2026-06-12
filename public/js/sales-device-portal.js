(() => {
  "use strict";

  const API = "/.netlify/functions";
  const SELLER_NOTICE =
    "Seller device mode: create a public quote link, then Firmar. Full send, email, and PDF remain disabled.";
  const SELLER_PUBLISH_RESULT_MSG =
    "Quote created. Firmar is now available. Full send, email, and PDF remain disabled.";
  const SELLER_FIRMAR_GATE_MSG =
    "Create a public quote link before using Firmar.";
  const SELLER_PORTAL_BLOCKED_MSG =
    "Seller portal requires a clean paired seller device session. Open this link from the assigned seller browser/profile.";
  const BLOCKED_ENDPOINT_RE = /\/send-quote-zapier/i;
  const BLOCKED_CONTROL_IDS = new Set([
    "btnSendQuote",
    "btnSendQuoteInline",
    "btnSendNow",
    "btnManagePlan",
    "btnSalesOpSend",
  ]);

  let sellerModeActive = false;
  let sellerPublishUiBusy = false;
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

  function isForcedSellerPortal() {
    return document.documentElement.dataset.salesPortal === "seller";
  }

  function applySellerPortalBlockedState() {
    sellerModeActive = false;
    window.MG_SALES_PORTAL_MODE = "seller-blocked";
    document.documentElement.dataset.authMode = "blocked";
    document.documentElement.dataset.portalType = "seller";

    hideOwnerChrome();
    removeSellerPublishUi();
    removeDeviceLogoutButton();

    const plan = document.getElementById("planStatus");
    if (plan) plan.textContent = "Seller portal · Session required";

    const email = document.getElementById("accountEmail");
    if (email) email.textContent = "Use a paired seller device profile";

    let notice = document.getElementById("mgSellerPortalBlockedNotice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "mgSellerPortalBlockedNotice";
      notice.className = "notice err";
      notice.setAttribute("role", "alert");
      const container = document.querySelector(".container");
      if (container) {
        container.insertBefore(notice, container.firstChild);
      } else {
        document.body.insertBefore(notice, document.body.firstChild);
      }
    }
    notice.textContent = SELLER_PORTAL_BLOCKED_MSG;
    notice.hidden = false;
    notice.style.display = "";

    document.querySelectorAll(".container .grid, .container > .card").forEach((el) => {
      el.setAttribute("hidden", "");
      el.setAttribute("aria-hidden", "true");
    });

    const navSales = document.getElementById("navSalesVendor");
    if (navSales) {
      navSales.href = "/seller";
      navSales.classList.add("active");
    }

    document.body.classList.add("auth-ready", "mg-seller-portal-blocked");
  }

  function applyOwnerMode(ownerData) {
    sellerModeActive = false;
    window.MG_SALES_PORTAL_MODE = "owner";
    document.documentElement.dataset.authMode = "owner";
    delete document.documentElement.dataset.portalType;
    removeSellerNotice();
    removeSellerPublishUi();
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

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sanitizePublicUrl(raw) {
    const url = String(raw || "").trim();
    if (!/^https?:\/\//i.test(url)) return "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return parsed.href;
    } catch (_err) {
      return "";
    }
  }

  function removeSellerPublishUi() {
    const shell = document.getElementById("mgSellerPublishShell");
    if (shell) shell.remove();
  }

  function readPublishedSnapshot() {
    if (typeof window.getSalesPublishedQuoteSnapshot === "function") {
      return window.getSalesPublishedQuoteSnapshot();
    }
    return null;
  }

  function hasPublishedQuoteForFirmar() {
    const snapshot = readPublishedSnapshot();
    return Boolean(
      snapshot &&
        String(snapshot.quote_id || "").trim() &&
        String(snapshot.public_url || "").trim()
    );
  }

  function syncSellerFirmarButtonState() {
    if (!sellerModeActive) return;
    const btn = document.getElementById("btnMarkSold");
    if (!btn) return;
    const canFirmar = hasPublishedQuoteForFirmar();
    btn.disabled = !canFirmar;
    btn.setAttribute("aria-disabled", btn.disabled ? "true" : "false");
    if (!canFirmar) {
      btn.title = SELLER_FIRMAR_GATE_MSG;
      btn.setAttribute("data-mg-seller-firmar-gated", "1");
    } else {
      btn.removeAttribute("data-mg-seller-firmar-gated");
      btn.title = "";
    }
  }

  function installFirmarGateGuard() {
    const btn = document.getElementById("btnMarkSold");
    if (!btn || btn.dataset.mgSellerFirmarGateBound === "1") return;
    btn.dataset.mgSellerFirmarGateBound = "1";
    btn.addEventListener(
      "click",
      (event) => {
        if (!sellerModeActive) return;
        if (hasPublishedQuoteForFirmar()) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        window.alert(SELLER_FIRMAR_GATE_MSG);
      },
      true
    );
  }

  function syncSellerPublishButtonState(btn) {
    if (!btn) return;
    const snapshot = readPublishedSnapshot();
    const hasPublished = Boolean(snapshot && snapshot.public_url);
    btn.disabled = sellerPublishUiBusy || hasPublished;
    btn.setAttribute("aria-disabled", btn.disabled ? "true" : "false");
    btn.textContent = hasPublished
      ? "Public quote link created"
      : "Create Public Quote Link";
  }

  function renderSellerPublishResult(result) {
    const panel = document.getElementById("mgSellerPublishResult");
    const btn = document.getElementById("btnSellerPublishPublicLink");
    if (!panel) return;

    const publicUrl = sanitizePublicUrl(result?.public_url);
    const quoteNumber = String(result?.quote_number_display || "").trim();
    const message = String(result?.message || SELLER_PUBLISH_RESULT_MSG);

    if (!publicUrl) {
      panel.hidden = true;
      panel.innerHTML = "";
      syncSellerPublishButtonState(btn);
      return;
    }

    panel.hidden = false;
    panel.innerHTML =
      '<div class="mg-seller-publish-result__title">Public quote link ready</div>' +
      (quoteNumber
        ? '<div class="mg-seller-publish-result__meta"><strong>Quote #</strong> ' +
          escapeHtml(quoteNumber) +
          "</div>"
        : "") +
      '<div class="mg-seller-publish-result__meta"><strong>Link</strong> ' +
      '<a href="' +
      escapeHtml(publicUrl) +
      '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(publicUrl) +
      "</a></div>" +
      '<div class="mg-seller-publish-result__actions">' +
      '<button type="button" class="btn secondary" id="btnSellerCopyPublicLink">Copy link</button>' +
      "</div>" +
      '<p class="mg-seller-publish-result__note">' +
      escapeHtml(message) +
      "</p>";

    const copyBtn = document.getElementById("btnSellerCopyPublicLink");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(publicUrl);
          } else {
            window.prompt("Copy this link:", publicUrl);
            return;
          }
          copyBtn.textContent = "Copied";
          setTimeout(() => {
            copyBtn.textContent = "Copy link";
          }, 1800);
        } catch (_err) {
          window.alert("Unable to copy link.");
        }
      });
    }

    syncSellerPublishButtonState(btn);
    rebindSellerFirmarControls();
  }

  function rebindSellerFirmarControls() {
    if (!sellerModeActive) return;
    syncSellerFirmarButtonState();
    installFirmarGateGuard();
    requestAnimationFrame(() => {
      syncSellerFirmarButtonState();
      installFirmarGateGuard();
    });
    setTimeout(() => {
      syncSellerFirmarButtonState();
      installFirmarGateGuard();
    }, 0);
  }

  async function handleSellerPublishClick() {
    const btn = document.getElementById("btnSellerPublishPublicLink");
    const panel = document.getElementById("mgSellerPublishResult");
    if (!btn || sellerPublishUiBusy) return;

    const existing = readPublishedSnapshot();
    if (existing && existing.public_url) {
      renderSellerPublishResult({
        public_url: existing.public_url,
        quote_number_display: existing.quote_number_display,
        message: SELLER_PUBLISH_RESULT_MSG,
      });
      return;
    }

    if (typeof window.runSellerPublishPublicLinkOnly !== "function") {
      window.alert("Publish is unavailable on this page.");
      return;
    }

    sellerPublishUiBusy = true;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.textContent = "Creating link…";
    if (panel) {
      panel.hidden = false;
      panel.innerHTML =
        '<p class="mg-seller-publish-result__note">Creating public quote link…</p>';
    }

    try {
      const result = await window.runSellerPublishPublicLinkOnly();
      if (!result || result.ok !== true) {
        throw new Error((result && result.error) || "Unable to create public quote link.");
      }
      renderSellerPublishResult(result);
    } catch (err) {
      if (panel) {
        panel.hidden = false;
        panel.innerHTML =
          '<p class="mg-seller-publish-result__note mg-seller-publish-result__note--error">' +
          escapeHtml(err.message || "Unable to create public quote link.") +
          "</p>";
      }
      syncSellerPublishButtonState(btn);
      rebindSellerFirmarControls();
    } finally {
      sellerPublishUiBusy = false;
      if (btn) btn.removeAttribute("aria-busy");
      syncSellerPublishButtonState(btn);
      rebindSellerFirmarControls();
    }
  }

  function ensureSellerPublishUi() {
    if (document.getElementById("mgSellerPublishShell")) return;

    const shell = document.createElement("div");
    shell.id = "mgSellerPublishShell";
    shell.className = "mg-seller-publish-shell";
    shell.style.margin = "12px 0";
    shell.innerHTML =
      '<button type="button" class="btn primary" id="btnSellerPublishPublicLink">Create Public Quote Link</button>' +
      '<div class="notice mg-seller-publish-result" id="mgSellerPublishResult" hidden></div>';

    const cta = document.querySelector(".sales-quote-cta");
    if (cta && cta.parentNode) {
      cta.parentNode.insertBefore(shell, cta);
    } else {
      const container = document.querySelector(".container");
      if (container) {
        container.insertBefore(shell, container.firstChild);
      }
    }

    const btn = document.getElementById("btnSellerPublishPublicLink");
    if (btn) {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleSellerPublishClick();
      });
    }

    const snapshot = readPublishedSnapshot();
    if (snapshot && snapshot.public_url) {
      renderSellerPublishResult({
        public_url: snapshot.public_url,
        quote_number_display: snapshot.quote_number_display,
        message: SELLER_PUBLISH_RESULT_MSG,
      });
    } else {
      syncSellerPublishButtonState(btn);
    }
    syncSellerFirmarButtonState();
    installFirmarGateGuard();
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
          // Client-side guard mirrors backend send-quote-zapier hard-deny code.
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ok: false,
                error: "Quote email send is not available on seller devices.",
                code: "seller_device_send_blocked",
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

    const navSales = document.getElementById("navSalesVendor");
    if (navSales && isForcedSellerPortal()) {
      navSales.href = "/seller";
      navSales.classList.add("active");
    }

    hideOwnerChrome();
    ensureSellerNotice();
    ensureSellerPublishUi();
    showSellerAccountPill(auth);
    ensureDeviceLogoutButton();
    disableBlockedControls();
    syncSellerFirmarButtonState();
    installFirmarGateGuard();
    installClickGuard();
    installFetchGuard();

    if (
      isForcedSellerPortal() &&
      typeof window.initializeSellerPortalQuoteState === "function"
    ) {
      window.initializeSellerPortalQuoteState();
    }

    // Inline sales handlers clone Firmar/send buttons on DOMContentLoaded; re-apply after they run.
    requestAnimationFrame(() => {
      disableBlockedControls();
      rebindSellerFirmarControls();
      setTimeout(() => {
        disableBlockedControls();
        rebindSellerFirmarControls();
      }, 0);
    });

    document.body.classList.add("auth-ready");
    window.dispatchEvent(
      new CustomEvent("device-auth-ready", { detail: { auth } })
    );
  }

  async function initSalesPortalAuth() {
    const forcedSeller = isForcedSellerPortal();

    if (forcedSeller) {
      const ownerData = await tryOwnerAuth();
      if (ownerData) {
        applySellerPortalBlockedState();
        return;
      }

      if (!window.MGDevicePortal?.init) {
        window.location.href = "/portal-pair?portal=seller&return=/seller";
        return;
      }

      const auth = await window.MGDevicePortal.init({ expectedPortal: "seller" });
      if (!auth) {
        return;
      }
      applySellerMode(auth);
      return;
    }

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
    isForcedSellerPortal,
    renderPublishResult: renderSellerPublishResult,
    rebindSellerFirmarControls,
    syncSellerFirmarButtonState,
  };
})();
