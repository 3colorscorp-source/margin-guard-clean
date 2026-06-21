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
  const SELLER_PORTAL_BLOCKED_PROFILE_HINT = "Use a paired seller device profile";
  const SELLER_BLOCKED_FALLBACK_SHELL_ID = "mgSellerBlockedFallbackShell";
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

  function isDirectSalesRouteWithoutForcedPortal() {
    if (isForcedSellerPortal()) return false;
    const path = String(window.location.pathname || "").toLowerCase();
    return /^\/sales(?:\.html)?\/?$/.test(path);
  }

  function redirectSellerDeviceToSafePortal() {
    window.location.replace("/seller");
  }

  function sellerSettingsReadyForQuote() {
    if (!sellerModeActive) return true;
    return window.__mgSellerBusinessSettingsReady === true;
  }

  function ensureSellerSettingsBlockedNotice(message) {
    let notice = document.getElementById("mgSellerSettingsBlockedNotice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "mgSellerSettingsBlockedNotice";
      notice.className = "notice err";
      notice.setAttribute("role", "alert");
      const sellerNotice = document.getElementById("mgSellerDeviceNotice");
      if (sellerNotice && sellerNotice.parentNode) {
        sellerNotice.parentNode.insertBefore(notice, sellerNotice.nextSibling);
      } else {
        const container = document.querySelector(".container");
        if (container) {
          container.insertBefore(notice, container.firstChild);
        }
      }
    }
    notice.textContent =
      message ||
      "Seller pricing settings are not loaded. Ask the owner to save Business Settings before creating a quote.";
    notice.hidden = false;
    notice.style.display = "";
  }

  function removeSellerSettingsBlockedNotice() {
    const notice = document.getElementById("mgSellerSettingsBlockedNotice");
    if (notice) notice.remove();
  }

  function isRealSellerPortalUrl() {
    const path = String(window.location.pathname || "").toLowerCase();
    if (!/^\/sales(?:\.html)?\/?$/.test(path)) return false;
    try {
      return new URLSearchParams(window.location.search || "").get("portal") === "seller";
    } catch (_err) {
      return false;
    }
  }

  function isOwnerPreviewPortalUrl() {
    const path = String(window.location.pathname || "").toLowerCase();
    if (!/^\/sales(?:\.html)?\/?$/.test(path)) return false;
    try {
      return new URLSearchParams(window.location.search || "").get("portal") === "owner";
    } catch (_err) {
      return false;
    }
  }

  function isValidPairedSellerDeviceSessionActive() {
    if (!sellerModeActive) return false;
    if (document.body.classList.contains("mg-seller-portal-blocked")) return false;
    if (document.documentElement.dataset.authMode === "blocked") return false;
    if (window.MG_SALES_PORTAL_MODE === "seller-blocked") return false;
    if (document.documentElement.dataset.authMode !== "device") return false;
    if (document.documentElement.dataset.portalType !== "seller") return false;
    return true;
  }

  function removeSellerBlockedFallbackShell() {
    const shell = document.getElementById(SELLER_BLOCKED_FALLBACK_SHELL_ID);
    if (shell) shell.remove();
    document.body.classList.remove("mg-seller-blocked-fallback-active");
    document.documentElement.classList.remove("mg-seller-blocked-fallback-active");
  }

  function ensureSellerBlockedFallbackShell() {
    if (!isRealSellerPortalUrl() || isOwnerPreviewPortalUrl()) {
      removeSellerBlockedFallbackShell();
      return false;
    }
    if (isValidPairedSellerDeviceSessionActive()) {
      removeSellerBlockedFallbackShell();
      return false;
    }
    if (
      !document.body.classList.contains("mg-seller-portal-blocked") &&
      document.documentElement.dataset.authMode !== "blocked"
    ) {
      return false;
    }

    document.documentElement.classList.add("mg-seller-blocked-fallback-active");
    document.body.classList.add("mg-seller-blocked-fallback-active");
    document.documentElement.style.setProperty("background", "#070b14", "important");
    document.body.style.setProperty("background", "#070b14", "important");
    document.body.style.setProperty("color", "#e8eefc", "important");

    let shell = document.getElementById(SELLER_BLOCKED_FALLBACK_SHELL_ID);
    if (!shell) {
      shell = document.createElement("div");
      shell.id = SELLER_BLOCKED_FALLBACK_SHELL_ID;
      shell.setAttribute("role", "alert");
      shell.setAttribute("aria-live", "assertive");
      shell.setAttribute("aria-label", "Seller portal blocked");
      document.body.appendChild(shell);
    }

    while (shell.firstChild) {
      shell.removeChild(shell.firstChild);
    }

    const inner = document.createElement("div");
    const hint = document.createElement("div");
    hint.textContent = SELLER_PORTAL_BLOCKED_PROFILE_HINT;
    const message = document.createElement("p");
    message.textContent = SELLER_PORTAL_BLOCKED_MSG;
    inner.appendChild(hint);
    inner.appendChild(message);
    shell.appendChild(inner);

    shell.hidden = false;
    shell.removeAttribute("aria-hidden");

    shell.style.setProperty("position", "fixed", "important");
    shell.style.setProperty("inset", "0", "important");
    shell.style.setProperty("z-index", "2147483000", "important");
    shell.style.setProperty("display", "flex", "important");
    shell.style.setProperty("flex-direction", "column", "important");
    shell.style.setProperty("align-items", "flex-start", "important");
    shell.style.setProperty("justify-content", "flex-start", "important");
    shell.style.setProperty("visibility", "visible", "important");
    shell.style.setProperty("opacity", "1", "important");
    shell.style.setProperty("pointer-events", "auto", "important");
    shell.style.setProperty("overflow", "auto", "important");
    shell.style.setProperty("box-sizing", "border-box", "important");
    shell.style.setProperty(
      "padding",
      "24px 24px 24px calc(var(--mg-sidebar-width, 64px) + 24px)",
      "important"
    );
    shell.style.setProperty("background", "#070b14", "important");
    shell.style.setProperty("color", "#e8eefc", "important");

    inner.style.setProperty("max-width", "72ch", "important");
    inner.style.setProperty("width", "100%", "important");
    inner.style.setProperty("margin", "0", "important");

    hint.style.setProperty("display", "inline-flex", "important");
    hint.style.setProperty("align-items", "center", "important");
    hint.style.setProperty("margin", "0 0 14px 0", "important");
    hint.style.setProperty("padding", "8px 14px", "important");
    hint.style.setProperty("border-radius", "999px", "important");
    hint.style.setProperty("background", "rgba(255, 255, 255, 0.045)", "important");
    hint.style.setProperty("color", "#e8eefc", "important");
    hint.style.setProperty("font-size", "13px", "important");
    hint.style.setProperty("line-height", "1.4", "important");

    message.style.setProperty("margin", "0", "important");
    message.style.setProperty("padding", "12px 14px", "important");
    message.style.setProperty("border-radius", "12px", "important");
    message.style.setProperty("border", "1px solid rgba(239, 68, 68, 0.35)", "important");
    message.style.setProperty("background", "rgba(239, 68, 68, 0.10)", "important");
    message.style.setProperty("color", "#e8eefc", "important");
    message.style.setProperty("font-size", "14px", "important");
    message.style.setProperty("line-height", "1.55", "important");

    return true;
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
    window.MGAppNav?.applyPortalMode?.("seller-device");
    ensureSellerBlockedFallbackShell();
  }

  function applyOwnerMode(ownerData) {
    removeSellerBlockedFallbackShell();
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
    window.MGAppNav?.applyPortalMode?.("owner");
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

  function getDeviceLogoutAnchor() {
    const shellAnchor = window.MGAppNav?.getDeviceLogoutAnchor?.();
    if (shellAnchor) return shellAnchor;
    return document.querySelector(".topbar-actions");
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

    const anchor = getDeviceLogoutAnchor();
    if (anchor) {
      anchor.appendChild(btn);
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
    if (sellerModeActive && !sellerSettingsReadyForQuote()) {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      btn.title = "Business Settings must load before Firmar.";
      btn.setAttribute("data-mg-seller-firmar-gated", "1");
      return;
    }
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
    const settingsBlocked = sellerModeActive && !sellerSettingsReadyForQuote();
    btn.disabled = sellerPublishUiBusy || hasPublished || settingsBlocked;
    btn.setAttribute("aria-disabled", btn.disabled ? "true" : "false");
    btn.textContent = settingsBlocked
      ? "Business Settings required"
      : hasPublished
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

  async function applySellerMode(auth) {
    removeSellerBlockedFallbackShell();
    sellerModeActive = true;
    window.MG_SALES_PORTAL_MODE = "device";
    document.documentElement.dataset.authMode = "device";
    document.documentElement.dataset.portalType = "seller";

    const plan = document.getElementById("planStatus");
    if (plan) plan.textContent = "Seller device · Vendedor";

    const navSales = document.getElementById("navSalesVendor");
    if (navSales) {
      navSales.href = "/seller";
      if (isForcedSellerPortal()) {
        navSales.classList.add("active");
      }
    }

    hideOwnerChrome();
    ensureSellerNotice();
    if (isForcedSellerPortal() && typeof window.initializeSellerPortalQuoteState === "function") {
      window.initializeSellerPortalQuoteState();
    }
    ensureSellerPublishUi();
    showSellerAccountPill(auth);
    ensureDeviceLogoutButton();
    disableBlockedControls();

    let settingsHydration = { ok: true };
    if (typeof window.hydrateSellerBusinessSettingsFromServer === "function") {
      settingsHydration = await window.hydrateSellerBusinessSettingsFromServer();
    } else {
      settingsHydration = {
        ok: false,
        error:
          "Seller pricing settings are not loaded. Ask the owner to save Business Settings before creating a quote.",
      };
    }
    if (!settingsHydration.ok) {
      ensureSellerSettingsBlockedNotice(settingsHydration.error);
    } else {
      removeSellerSettingsBlockedNotice();
    }

    syncSellerFirmarButtonState();
    installFirmarGateGuard();
    installClickGuard();
    installFetchGuard();

    if (settingsHydration.ok && typeof window.refreshSellerFromStandalone === "function") {
      window.refreshSellerFromStandalone();
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
    window.MGAppNav?.applyPortalMode?.("seller-device");
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
      await applySellerMode(auth);
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

    if (isDirectSalesRouteWithoutForcedPortal()) {
      redirectSellerDeviceToSafePortal();
      return;
    }

    await applySellerMode(auth);
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
